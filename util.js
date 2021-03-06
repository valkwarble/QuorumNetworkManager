var exec = require('child_process').exec;
var ps = require('ps-node')
var fs = require('fs');
var async = require('async')

var ports = require('./config.js').ports

function killallGethConstellationNode(cb){
  var cmd = 'killall -9';
  cmd += ' geth';
  cmd += ' constellation-node';
  var child = exec(cmd, function(){
    cb(null, null);
  });
  child.stderr.on('data', function(error){
    console.log('ERROR:', error);
    cb(error, null);
  });
}

function clearDirectories(result, cb){
  var cmd = 'rm -rf';
  for(var i in result.folders){
    var folder = result.folders[i];
    cmd += ' '+folder;    
  }
  var child = exec(cmd, function(){
    cb(null, result);
  });
  child.stderr.on('data', function(error){
    console.log('ERROR:', error);
    cb(error, null);
  });
}

function createDirectories(result, cb){
  var cmd = 'mkdir';
  for(var i in result.folders){
    var folder = result.folders[i];
    cmd += ' '+folder;    
  }
  var child = exec(cmd, function(){
    cb(null, result);
  });
  child.stderr.on('data', function(error){
    console.log('ERROR:', error);
    cb(error, null);
  });
}

function hex2a(hexx) {
  var hex = hexx.toString();//force conversion
  var str = '';
  for (var i = 0; i < hex.length; i += 2){
    str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  }
  return str;
}

// TODO: Add failure after a number of retries
function waitForIPCPath(path, cb){
  if (fs.existsSync(path)) {
    cb()
  } else {
    setTimeout(function(){
      waitForIPCPath(path, cb)
    }, 1000)
  }
}

function createWeb3IPC(ipcProvider){
  let Web3IPC = require('web3_ipc');
  let options = {
    host: ipcProvider,
    ipc: true,
    personal: true,
    admin: true,
    debug: false
  };
  let web3IPC = Web3IPC.create(options);
  let web3IPCConnection = web3IPC.currentProvider.connection
  return web3IPC
}

function waitForRPCConnection(web3RPC, cb){
  web3RPC.eth.net.isListening(function(err, isListening){
    if(isListening === true){
      console.log('[*] RPC connection established')
      cb()
    } else {
      setTimeout(function(){
        console.log('waiting for RPC connection ...')
        waitForRPCConnection(web3RPC, cb)
      }, 1000)
    }
  })
}

// TODO: add error handler here for web3 connections so that program doesn't exit on error
function createWeb3Connection(result, cb){
  let ipcProvider = result.web3IPCHost;
  waitForIPCPath(ipcProvider, function(){
    // Web3 WS RPC
    let web3WSRPC
    if(result.web3WSRPCProvider){
      let wsProvider = result.web3WSRPCProvider;
      let Web3 = require('web3');
      web3WSRPC = new Web3(wsProvider);
      result.web3WSRPC = web3WSRPC;
    }
    // Web3 http RPC
    let httpProvider = result.web3RPCProvider;
    let Web3RPC = require('web3');
    let web3RPC = new Web3RPC(httpProvider);
    result.web3RPC = web3RPC
    waitForRPCConnection(result.web3RPC, function(){
      result.web3IPC = createWeb3IPC(ipcProvider)
      // Web3 RPC Quorum
      let Web3Quorum = require('web3-raft');
      let web3RPCQuorum = new Web3Quorum(httpProvider);
      result.web3RPCQuorum = web3RPCQuorum;
      console.log('[*] Node started')
      cb(null, result);
    })
  })
}

function connectToPeer(result, cb){
  var enode = result.enode;
  result.web3IPC.admin.addPeer(enode, function(err, res){
    if(err){console.log('ERROR:', err);}
    cb(null, result);
  });
}

function getNewGethAccount(result, cb){
  var options = {encoding: 'utf8', timeout: 10*1000};
  var child = exec('geth --datadir Blockchain account new', options);
  child.stdout.on('data', function(data){
    if(data.indexOf('Your new account') >= 0){
      child.stdin.write('\n');
    } else if(data.indexOf('Repeat') >= 0){
      child.stdin.write('\n');
    } else if(data.indexOf('Address') == 0){
      var index = data.indexOf('{');
      var address = '0x'+data.substring(index+1, data.length-2);
      if(result.addressList == undefined){
        result.addressList = [];
      }
      result.addressList.push(address);
      cb(null, result);
    } 
  });
  child.stderr.on('data', function(error){
    if(error.indexOf('No etherbase set and no accounts found as default') < 0){
      console.log('ERROR:', error);
      cb(error, null);
    }
  });
}

function instanceAlreadyRunningMessage(processName){
  console.log('\n--- NOTE: There is an instance of '+processName+' already running.'+
    ' Please kill this instance by selecting option 5 before continuing\n')
}

function checkPreviousCleanExit(cb){
  async.parallel({
    geth: function(callback){
      ps.lookup({
        command: 'geth',
        psargs: 'ef'
      }, 
      function(err, resultList){
        callback(err, resultList)
      })
    }, 
    constellation: function(callback){
      ps.lookup({
        command: 'constellation-node',
        psargs: 'ef'
      }, 
      function(err, resultList){
        callback(err, resultList)
      })
    } 
  }, function(err, result){
    if(result && result.geth && result.geth.length > 0){
      instanceAlreadyRunningMessage('geth')
    }
    if(result && result.constellation && result.constellation.length > 0){
      instanceAlreadyRunningMessage('constellation')
    }
    cb(err, true)
  })
}

function createRaftGenesisBlockConfig(result, cb){
  let genesisTemplate = {
    "alloc": {},
    "coinbase": result.blockMakers[0],
    "config": {
      "homesteadBlock": 0,
      "chainId": 1,
      "eip155Block": null,
      "eip158Block": null,
      "isQuorum": true
    },
    "difficulty": "0x0",
    "extraData": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "gasLimit": "0xE0000000",
    "mixhash": "0x00000000000000000000000000000000000000647572616c65787365646c6578",
    "nonce": "0x0",
    "parentHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "timestamp": "0x00"
  }

  for(let key in result.blockMakers){
    genesisTemplate.alloc[result.blockMakers[key]] = {
      "balance": "1000000000000000000000000000"
    }
  }

  let genesisConfig = JSON.stringify(genesisTemplate)

  fs.writeFile('quorum-genesis.json', genesisConfig, 'utf8', function(err, res){
    result.communicationNetwork.genesisBlockConfigReady = true;
    cb(err, result);
  })
}

function isWeb3RPCConnectionAlive(web3RPC){
  let isAlive = false
  try{
    let accounts = web3RPC.eth.accounts
    if(accounts){
      isAlive = true
    }
  } catch(err){ } 
  return isAlive 
}

function getEnodePubKey(cb){
  let options = {encoding: 'utf8', timeout: 10*1000};
  let child = exec('bootnode -nodekey Blockchain/geth/nodekey -writeaddress', options)
  child.stdout.on('data', function(data){
    data = data.slice(0, -1)
    cb(null, data)
  })
  child.stderr.on('data', function(error){
    console.log('ERROR:', error)
    cb(error, null)
  })
}

function generateEnode(result, cb){
  var options = {encoding: 'utf8', timeout: 10*1000};
  console.log('Generating node key')
  var child = exec('bootnode -genkey Blockchain/geth/nodekey', options)
  child.stderr.on('data', function(error){
    console.log('ERROR:', error)
  })
  child.stdout.on('close', function(error){
    getEnodePubKey(function(err, pubKey){
      let enode = 'enode://'+pubKey+'@'+result.localIpAddress+':'+ports.gethNode+
        '?raftport='+ports.raftHttp
      result.nodePubKey = pubKey
      result.enodeList = [enode]
      cb(null, result)
    })
  })
}

function displayEnode(result, cb){
  let options = {encoding: 'utf8', timeout: 10*1000};
  let child = exec('bootnode -nodekey Blockchain/geth/nodekey -writeaddress', options)
  child.stdout.on('data', function(data){
    data = data.slice(0, -1)
    let enode = 'enode://'+data+'@'+result.localIpAddress+':'+ports.gethNode+'?raftport='+ports.raftHttp
    console.log('\nenode:', enode+'\n')
    //result.nodePubKey = data
    //result.enodeList = [enode] // TODO: investigate why this is a list
    cb(null, result)
  })
  child.stderr.on('data', function(error){
    console.log('ERROR:', error)
    cb(error, null)
  })
}

function displayCommunicationEnode(result, cb){
  if(!result){
    return cb({error: 'parameter not defined, could not get ip address'}, null)
  }
  var options = {encoding: 'utf8', timeout: 10*1000};
  var child = exec('bootnode -nodekey CommunicationNode/geth/nodekey -writeaddress', options)
  child.stdout.on('data', function(data){
    data = data.slice(0, -1)
    let enode = 'enode://'+data+'@'+result.localIpAddress+':'
      +ports.communicationNode
    console.log('\n', enode+'\n')
    result.nodePubKey = data
    result.enodeList = [enode]
    cb(null, result)
  })
  child.stderr.on('data', function(error){
    console.log('ERROR:', error)
    cb(error, null)
  })
}

function unlockAllAccounts(result, cb){
  console.log('[INFO] Unlocking all accounts ...');
  async.each(result.web3RPC.eth.accounts, function(account, callback){
    result.web3IPC.personal.unlockAccount(account, '', 999999, function(err, res){
      callback(err, res)
    })
  }, function(err){
    if(err){
      console.log('ERROR:', err)
    } else {
      console.log('[INFO] All accounts unlocked')
    }
    cb(null, result)
  })
}

exports.Hex2a = hex2a
exports.ClearDirectories = clearDirectories
exports.CreateDirectories = createDirectories
exports.CreateWeb3Connection = createWeb3Connection
exports.ConnectToPeer = connectToPeer
exports.KillallGethConstellationNode = killallGethConstellationNode
exports.GetNewGethAccount = getNewGethAccount
exports.CheckPreviousCleanExit = checkPreviousCleanExit
exports.CreateRaftGenesisBlockConfig = createRaftGenesisBlockConfig
exports.IsWeb3RPCConnectionAlive = isWeb3RPCConnectionAlive
exports.GenerateEnode = generateEnode
exports.DisplayEnode = displayEnode
exports.DisplayCommunicationEnode = displayCommunicationEnode
exports.UnlockAllAccounts = unlockAllAccounts

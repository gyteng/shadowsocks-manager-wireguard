const dgram = require('dgram');
const exec = require('child_process').exec;
const client = dgram.createSocket('udp4');
const version = require('./package.json').version;
const db = require('./db');
const rop = require('./runOtherProgram');
const http = require('http');

let clientIp = [];

const netConfig = process.argv[2] || '10.100.0.0/16';
const managerConfig = process.argv[3] || '0.0.0.0:6002';
const mPort = +managerConfig.split(':')[1];
client.bind(mPort);

let lastFlow;

const runCommand = async cmd => {
  return new Promise((resolve, reject) => {
    exec(cmd, async (err, stdout, stderr) => {
      if(err) {
        console.error(err);
        return reject(stderr);
      } else {
        return resolve(stdout);
      }
    });
  });
};

const sendAddMessage = async (port, password) => {
  console.log('add: ' + password.trim());
  const a = port % 254;
  const b = (port - a) / 254;
  await runCommand(`wg set wg0 peer ${ password.trim() } allowed-ips ${ netConfig.split('.')[0] }.${ netConfig.split('.')[1] }.${ b }.${ a + 1 }/32`);
  return Promise.resolve('ok');
};

// setInterval(() => {
//   for(let i = 0; i < 10; i++) {
//     if(!addMessageCache.length && !libevListed) { continue; }
//     const message = addMessageCache.shift();
//     if(!message) { continue; }
//     const exists = !!portsForLibevObj[message.port];
//     if(exists) { continue; }
//     console.log(`增加ss端口: ${ message.port } ${ message.password }`);
//     client.send(`add: {"server_port": ${ message.port }, "password": "${ message.password }"}`, port, host);
//     rop.run(message.port, message.password);
//   }
// }, 1000);

const sendDelMessage = async (port, password) => {
  if(password) {
    console.log('del: ' + password);
    await runCommand(`wg set wg0 peer ${ password } remove`);
    return Promise.resolve('ok');
  }
  const accounts = await db.listAccountObj();
  console.log('del: ' + accounts[port]);
  await runCommand(`wg set wg0 peer ${ accounts[port] } remove`);
  return Promise.resolve('ok');
};

let existPort = [];
let existPortUpdatedAt = Date.now();
const setExistPort = flow => {
  existPort = [];
  if(Array.isArray(flow)) {
    existPort = flow.map(f => +f.server_port);
  } else {
    for(const f in flow) {
      existPort.push(+f);
    }
  }
  existPortUpdatedAt = Date.now();
};

const compareWithLastFlow = (flow, lastFlow) => {
  const realFlow = [];
  if(!lastFlow) {
    return flow.map(m => {
      return { port: m.port, flow: m.flow };
    }).filter(f => f.flow > 0);
  }
  for(const f of flow) {
    const last = lastFlow.filter(la => la.port === f.port)[0];
    if(last && f.flow - last.flow >= 0) {
      realFlow.push({
        port: f.port,
        flow: f.flow - last.flow,
      })
    } else {
      realFlow.push({
        port: f.port,
        flow: f.flow,
      });
    }
  }
  return realFlow.filter(f => f.flow > 0);;
};

let firstFlow = true;

const startUp = async () => {
  const result = await runCommand('wg show wg0 transfer');
  const peers = result.split('\n').filter(f => f).map(m => {
    const data = m.split('\t');
    return data[0];
  });
  const accounts = await db.listAccount();
  for(const account of accounts) {
    if(!peers.includes(account.password)) {
      await sendAddMessage(account.port, account.password);
    }
  }
};

const resend = async () => {
  const result = await runCommand('wg show wg0 transfer');
  const peers = result.split('\n').filter(f => f).map(m => {
    const data = m.split('\t');
    return {
      key: data[0],
      flow: (+data[1]) + (+data[2]),
    };
  });
  const accounts = await db.listAccount();
  for(const account of accounts) {
    if(!peers.map(m => m.key).includes(account.password)) {
      await sendAddMessage(account.port, account.password);
    }
  }
  for(const peer of peers) {
    if(!accounts.map(m => m.password).includes(peer.key)) {
      await sendDelMessage(null, peer.key);
    } else {
      peer.port = accounts.filter(f => f.password === peer.key)[0].port;
    }
  }
  const peersWithPort = peers.filter(f => f.port);
  const realFlow = compareWithLastFlow(peersWithPort, lastFlow);
  lastFlow = peersWithPort;
  const insertFlow = realFlow.map(m => {
    return {
      port: +m.port,
      flow: +m.flow,
      time: Date.now(),
    };
  }).filter(f => {
    return f.flow > 0;
  });

  if(insertFlow.length > 0) {
    if(firstFlow) {
      firstFlow = false;
    } else {
      for(let i = 0; i < Math.ceil(insertFlow.length/50); i++) {
        await db.insertFlow(insertFlow.slice(i * 50, i * 50 + 50));
      }
    }
  }
};

let isGfw = 0;
let getGfwStatusTime = null;
const getGfwStatus = () => {
  if(getGfwStatusTime && isGfw === 0 && Date.now() - getGfwStatusTime < 600 * 1000) { return; }
  getGfwStatusTime = Date.now();
  const sites = [
    'baidu.com:80',
  ];
  const site = sites[0];
  // const site = sites[+Math.random().toString().substr(2) % sites.length];
  const req = http.request({
    hostname: site.split(':')[0],
    port: +site.split(':')[1],
    path: '/',
    method: 'GET',
    timeout: 2000,
  }, res => {
    if(res.statusCode === 200) {
      isGfw = 0;
    }
    res.setEncoding('utf8');
    res.on('data', (chunk) => {});
    res.on('end', () => {});
  });
  req.on('timeout', () => {
    req.abort();
    isGfw += 1;
  });
  req.on('error', (e) => {
    isGfw += 1;
  });
  req.end();
};

startUp();
setInterval(() => {
  resend();
  getGfwStatus();
}, 60 * 1000);

const addAccount = (port, password) => {
  return db.addAccount(port, password).then(success => {
    sendAddMessage(port, password);
  }).then(() => {
    return { port, password };
  });
};

const removeAccount = port => {
  return db.removeAccount(port).then(() => {
    return sendDelMessage(port);
  }).then(() => {
    return { port };
  });
};

const changePassword = (port, password) => {
  return db.updateAccount(port, password).then(() => {
    return sendDelMessage(port);
  }).then(() => {
    return sendAddMessage(port, password);
  }).then(() => {
    return { port };
  });
};

const listAccount = () => {
  return Promise.resolve(db.listAccount());
};

const getFlow = (options) => {
  const startTime = options.startTime || 0;
  const endTime = options.endTime || Date.now();
  return db.getFlow(options);
};

const getVersion = () => {
  return Promise.resolve({
    version: version + 'T',
    isGfw: !!(isGfw > 5),
  });
};

const getClientIp = port => {
  // clientIp = clientIp.filter(f => {
  //   return Date.now() - f.time <= 15 * 60 * 1000;
  // });
  // const result = [];
  // clientIp.filter(f => {
  //   return Date.now() - f.time <= 15 * 60 * 1000 && f.port === port;
  // }).map(m => {
  //   return m.ip;
  // }).forEach(f => {
  //   if(result.indexOf(f) < 0) { result.push(f); }
  // });
  return Promise.resolve([]);
};

exports.addAccount = addAccount;
exports.removeAccount = removeAccount;
exports.changePassword = changePassword;
exports.listAccount = listAccount;
exports.getFlow = getFlow;
exports.getVersion = getVersion;
exports.getClientIp = getClientIp;
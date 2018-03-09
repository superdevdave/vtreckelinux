const si = require('systeminformation');
const notifier = require('node-notifier');
const fs = require('fs');
const jsonfile = require('jsonfile');
const win32Software = require('fetch-installed-software');
const darwinSoftware = require('apple-system-profiler');
const hexToDec = require('hex-to-dec');
const amqplib = require('amqplib/callback_api');
const Ping = require('ping-lite');
const http = require('http');
var vtrackConfig = {};

async function processCheckIn() {
  //showMessage('V-Track', 'getting hardware data');
  var machine = await si.getStaticData();
  machine.platform = process.platform;
  //machine.generateOn = getDate();
  //showMessage('V-Track', 'getting os info');
  //machine.osInfo = await si.osInfo();
  //showMessage('V-Track', 'getting users');
  machine.users = await si.users();
  //showMessage('V-Track', 'getting filesystems');
  machine.logicalDrives = await si.fsSize();
  //showMessage('V-Track', 'getting processes');
  machine.processes = await si.processes();

  //showMessage('V-Track', 'getting installed software');
  if (process.platform === 'win32') {
    var software = await win32Software.getAllInstalledSoftware();
    machine.software = software.map(restructureWin32Software).filter(item => item.DisplayName !== undefined);
    startPublishProcess(machine);
  } else if (process.platform === 'darwin') {
    await darwinSoftware({
      dataTypes: ['SPApplicationsDataType']
    }, (err, out) => {
      if (err) throw err;

      machine.software = out[0].items.map(restructureDarwinSoftware);
      startPublishProcess(machine);
    });
  }

  //showMessage('V-Track', 'Checking in ' + machine.system.serial);



  jsonfile.writeFile('machine.json', machine, (err) => {
    if (err) throw err;
  });
  //console.log('processing checkin for device with serial "' + machine.system.serial + '"');

  //console.log(machine);
  checkInTimeout = setTimeout(function() {
    processMessageQueue();
    processCheckIn();
  }, 60 * 60 * 1000);
}

function startPublishProcess(machine) {
  var ping = new Ping(vtrackConfig.NetworkServer);

  ping.send(function(err, ms) {
    //console.log(ping._host + ' responded in ' + ms + ' ms');

    if (ms) {
      // Can ping network server
      console.log('network check-in');
      publishNetworkCheckIn(machine);
    } else {
      // Need to check in over the internet
      console.log('internet check-in');
      publishInternetCheckIn(machine);
    }
  });
}

function restructureWin32Software(item) {
  return {
    "DisplayVersion": item.DisplayVersion,
    "InstallDate": item.InstallDate,
    "Publisher": item.Publisher,
    "EstimatedSize": hexToDec(item.sEstimatedSize2),
    "DisplayName": item.DisplayName,
  };
}

function restructureDarwinSoftware(item) {
    return {
        "DisplayVersion": item.version,
        "InstallDate": null,
        "Publisher": item.info,
        "EstimatedSize": 0,
        "DisplayName": item._name,
    };
}

async function processMessageQueue() {
  var system = await si.system();
  var serial = system.serial;
  var queue = vtrackConfig.Company + '.client.' + serial;
  var open = amqplib.connect('amqps://' + vtrackConfig.Company + ':' + vtrackConfig.MQPassword + '@' + vtrackConfig.MQServer + '/' + vtrackConfig.Company, {rejectUnauthorized: false}, function(err, conn) {
    if (err === null) {
      conn.createChannel(function (err, ch) {
        if (err === null) {
          ch.assertQueue(queue, {durable: true}, function(err, ok) {
            if (err === null) {
              ch.consume(queue, function (msg) {
                if (msg !== undefined && msg !== null) {
                  //ch.ack(msg);
                }
              }, {noAck: true}, function (err, ok) {
                ch.close();
                conn.close();
              });
            }
          });
        }
      });
    }
  });
}

function publishInternetCheckIn(machine) {
  var routingKey = vtrackConfig.Company + '.server2.message';
  var open = amqplib.connect('amqps://' + vtrackConfig.Company + ':' + vtrackConfig.MQPassword + '@' + vtrackConfig.MQServer + '/' + vtrackConfig.Company, {rejectUnauthorized: false}, function(err, conn) {
    if (err === null) {
      conn.createChannel(function (err, ch) {
        if (err === null) {
          ch.assertExchange('amq.topic', 'topic', {durable: true}, function(err, ok) {
            if (err === null) {
              var options = {
                replyTo: vtrackConfig.Company + '.client.' + machine.system.serial,
                type: 'checkin'
              };
              ch.publish('amq.topic', routingKey, new Buffer(JSON.stringify(machine)), options, function(err, ok) {
                ch.close();
                conn.close();
              });
            }
          });
        }
      });
    }
  });
}

function publishNetworkCheckIn(machine) {
  var postData = JSON.stringify(machine);

  console.log("'" + JSON.stringify(machine) + "'");

  var options = {
    hostname: vtrackConfig.NetworkHost,
    port: vtrackConfig.NetworkPort,
    path: vtrackConfig.NetworkPath,
    method: "POST",
  	"data": JSON.stringify(machine),
  	"headers": {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postData)
    }
  };

  var req = http.request(options, (res) => {
    console.log('STATUS: ' + res.statusCode);
    console.log('HEADERS: ' + JSON.stringify(res.header));
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      console.log(`BODY: ${chunk}`);
    });
    res.on('end', () => {
      console.log('No more data in response.');
    });
  });

  req.on('error', (e) => {
    console.error(`problem with request: ${e.message}`);
  });

  // write data to request body
  req.write(postData);
  req.end();
}

function showMessage(_title, _message) {
  notifier.notify({
    title: _title,
    message: _message,
    //appID: 'V-Track'
  });
}

function loadConfig() {
  return JSON.parse(fs.readFileSync('./vtrack.config').toString());
}

function start() {
  vtrackConfig = loadConfig();
  processMessageQueue();
  processCheckIn();
}

start();

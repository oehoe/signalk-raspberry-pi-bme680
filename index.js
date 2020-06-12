/*
 * 2020 J den Uijl
 */


const { Bme680 } = require('bme680-sensor')

module.exports = function (app) {
  let timer = null
  let plugin = {}

  plugin.id = 'signalk-raspberry-pi-bme680'
  plugin.name = 'Raspberry-Pi BME680'
  plugin.description = 'BME680 temperature, pressure and humidity sensors on Raspberry-Pi'

  plugin.schema = {
    type: 'object',
    properties: {
      rate: {
        title: "Sample Rate (in seconds)",
        type: 'number',
        default: 60
      },
      path: {
        type: 'string',
        title: 'SignalK Path',
        description: 'This is used to build the path in Signal K. It will be appended to \'environment\'',
        default: 'inside'
      },
      i2c_bus: {
        type: 'integer',
        title: 'I2C bus number',
        default: 1,
      },
      i2c_address: {
        type: 'string',
        title: 'I2C address',
        default: '0x77',
      },
    }
  }

  plugin.start = function (options) {
    
    function createDeltaMessage (temperature, humidity, pressure) {
      return {
        'context': 'vessels.' + app.selfId,
        'updates': [
          {
            'source': {
              'label': plugin.id
            },
            'timestamp': (new Date()).toISOString(),
            'values': [
              {
                'path': 'environment.' + options.path + '.temperature',
                'value': temperature
              }, {
                'path': 'environment.' + options.path + '.humidity',
                'value': humidity
              }, {
                'path': 'environment.' + options.path + '.pressure',
                'value': pressure
              }
            ]
          }
        ]
      }
    }

    const bme680 = new Bme680(options.i2c_bus || 1, Number(options.i2c_address || '0x77'));
    //const bme680 = new Bme680(1, 0x77);

    // Read BME680 sensor data
    function readSensorData() {

      bme680.initialize().then(async () => {
        app.debug('BME680 Sensor initialized');
        timer = setInterval(async () => {
            try {
              var sensorData = await bme680.getSensorData();
              temperature = sensorData.data.temperature;
              pressure = sensorData.data.pressure;
              humidity = sensorData.data.humidity;

              // create message
              var delta = createDeltaMessage(temperature, humidity, pressure);

              // send data
              app.handleMessage(plugin.id, delta);

            } catch(err) {
              var delta = createDeltaMessage(null, null, null);
              app.handleMessage(plugin.id, delta);
            }

        }, options.rate * 1000);
      })
      .catch((err) => {
        app.debug('Unable to initialize BME680');
        var delta = createDeltaMessage(null, null, null);
        app.handleMessage(plugin.id, delta);
      });
    }
    app.debug("Started Plugin BME680");
    readSensorData();
  }

  plugin.stop = function () {
    if(timer){
      clearInterval(timer);
      timeout = null;
    }
  }

  return plugin
}

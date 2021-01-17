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
        title: 'Sample Rate (in seconds)',
        description: 'Time between readings',
        type: 'number',
        default: 5
      },
      burn_in_time: {
        title: 'Burn in time (in seconds)',
        description: 'Defines the time the sensor will heat up to calculate the gas baseline. Default: 500',
        type: 'number',
        default: 500
      },
      hum_baseline: {
        title: 'Humidity baseline (in %)',
        description: '40% is considered to be an optimal indoor humidity',
        type: 'number',
        default: 40
      },
      hum_weighting: {
        title: 'Humidity weighting (in %)',
        description: 'This Sets the balance between humidity and gas reading in the calculation of air_quality_index. Default: 25:75, humidity:gas',
        type: 'number',
        default: 25
      },
      path1: {
        type: 'string',
        title: 'SignalK Path for temperature',
        description: 'This is used to build the path in Signal K for the temperature. It will be appended to \'environment\'',
        default: 'inside'
      },
      path2: {
        type: 'string',
        title: 'SignalK Path for humidity',
        description: 'This is used to build the path in Signal K for the humidity. It will be appended to \'environment\'',
        default: 'inside'
      },
      path3: {
        type: 'string',
        title: 'SignalK Path for pressure',
        description: 'This is used to build the path in Signal K for the pressure. It will be appended to \'environment\'',
        default: 'inside'
      },
      path4: {
        type: 'string',
        title: 'SignalK Path for gas and air quality',
        description: 'This is used to build the path in Signal K for the gas and air quality. It will be appended to \'environment\'',
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
    
    function createDeltaMessage (temperature, humidity, pressure, gas_resistance, air_quality_index) {
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
                'path': 'environment.' + options.path1 + '.temperature',
                'value': temperature
              }, {
                'path': 'environment.' + options.path2 + '.humidity',
                'value': humidity
              }, {
                'path': 'environment.' + options.path3 + '.pressure',
                'value': pressure
              }, {
                'path': 'environment.' + options.path4 + '.gas',
                'value': gas_resistance
              }, {
                'path': 'environment.' + options.path4 + '.airquality',
                'value': air_quality_index
              }
            ]
          }
        ]
      }
    }

    const bme680 = new Bme680(options.i2c_bus || 1, Number(options.i2c_address || '0x77'));
    //const bme680 = new Bme680(1, 0x77);

    var gas_baseline;
    var burn_in_data = [];
    
    // Sensor initialization and burn in periode
    function SensorBurnIn() {
    
      bme680.initialize().then(async () => {
        app.debug('BME680 Sensor initialized');
        burnin = setInterval(async () => {
          try {
              var sensorData = await bme680.getSensorData();
              temperature = sensorData.data.temperature + 273.15;
              pressure = sensorData.data.pressure * 100;
              humidity = sensorData.data.humidity;
              gas_resistance = sensorData.data.gas_resistance;
              burn_in_data.push(gas_resistance);
              
              // create message
              var delta = createDeltaMessage(temperature, humidity, pressure, gas_resistance, null);
              
              // send data
              app.handleMessage(plugin.id, delta);
          } catch(err) {
              var delta = createDeltaMessage(null, null, null, null, null);
              app.handleMessage(plugin.id, delta);
          }
        }, 1000);
      })
      .catch((err) => {
        app.debug('Unable to initialize BME680');
        var delta = createDeltaMessage(null, null, null, null, null);
        app.handleMessage(plugin.id, delta);
      });
    }
    
    // End of the burn in periode
    function EndBurnIn() {
      
      // calculate gas baseline     
      gas_baseline = burn_in_data.slice(-50).reduce((a, b) => a + b) / burn_in_data.slice(-50).length;
      // stop the burn in
      clearInterval(burnin);
    }
    
	  
    // Read BME680 sensor data
    function readSensorData() {

      timer = setInterval(async () => {
        try {
          var sensorData = await bme680.getSensorData();
          temperature = sensorData.data.temperature + 273.15;
          pressure = sensorData.data.pressure * 100;
          humidity = sensorData.data.humidity;
          gas_resistance = sensorData.data.gas_resistance;
          hum_offset = humidity - options.hum_baseline;
	  gas_offset = gas_baseline - gas_resistance;
              
          // calculate hum_score as the distance from the hum_baseline
          if (hum_offset > 0) {
              hum_score = (100 - options.hum_baseline - hum_offset) / (100 - options.hum_baseline) * (options.hum_weighting);
          } else {
              hum_score = (options.hum_baseline + hum_offset) / options.hum_baseline * (options.hum_weighting);
          }
              
          // calculate gas_score as the distance from the gas_baseline
          if (gas_offset > 0) {
              gas_score = (gas_resistance / gas_baseline) * (100 - options.hum_weighting);
          } else {
            gas_score = 100 - options.hum_weighting;
          }

          // calculate air_quality_score
          air_quality_score = hum_score + gas_score;
          // convert to Air Quality Index
          air_quality_index = Math.round(500 - (5 * air_quality_score));
             
          // create message
          var delta = createDeltaMessage(temperature, humidity, pressure, gas_resistance, air_quality_index);

          // send data
          app.handleMessage(plugin.id, delta);

	} catch(err) {
          var delta = createDeltaMessage(null, null, null, null, null);
          app.handleMessage(plugin.id, delta);
        }

      }, options.rate * 1000);
    }
    
    app.debug("Started Plugin BME680");
    setTimeout(EndBurnIn, options.burn_in_time * 1000);
    SensorBurnIn();
    setTimeout(readSensorData, (options.burn_in_time + 1) * 1000);
  }

  plugin.stop = function () {
    if(timer){
      clearInterval(timer);
      timeout = null;
    }
  }

  return plugin
}

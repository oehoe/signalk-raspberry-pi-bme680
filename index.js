/*
 * 2020 J den Uijl
 */


const { Bme680 } = require('bme680-sensor')

module.exports = function (app) {
  let timer = null
  let plugin = {}

  plugin.id = 'signalk-raspberry-pi-bme680'
  plugin.name = 'Raspberry-Pi BME680'
  plugin.description = 'BME680 temperature, pressure, humidity and air quality sensors on Raspberry-Pi'

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

  // Defaults taken from the schema, so a partial or empty configuration still works
  // (e.g. a missing "rate" would otherwise make setInterval fire every millisecond).
  function withDefaults (options) {
    const out = {}
    for (const [key, prop] of Object.entries(plugin.schema.properties)) {
      out[key] = prop.default
    }
    for (const [key, value] of Object.entries(options || {})) {
      if (value !== undefined && value !== null && value !== '') out[key] = value
    }
    for (const key of ['rate', 'burn_in_time', 'hum_baseline', 'hum_weighting', 'i2c_bus']) {
      out[key] = Number(out[key])
      if (!Number.isFinite(out[key])) out[key] = plugin.schema.properties[key].default
    }
    if (out.rate <= 0) out.rate = plugin.schema.properties.rate.default
    if (out.burn_in_time < 0) out.burn_in_time = plugin.schema.properties.burn_in_time.default
    return out
  }

  // Timers owned by the running instance; all of them are cleared in stop().
  let burnin = null
  let timers = []
  let running = false

  function later (fn, ms) {
    const t = setTimeout(() => {
      timers = timers.filter(x => x !== t)
      fn()
    }, ms)
    timers.push(t)
  }

  function setStatus (msg) {
    if (typeof app.setPluginStatus === 'function') app.setPluginStatus(msg)
  }

  function setError (msg) {
    if (typeof app.setPluginError === 'function') app.setPluginError(msg)
    else if (typeof app.error === 'function') app.error(msg)
  }

  plugin.start = function (rawOptions) {
    const options = withDefaults(rawOptions)
    running = true
    // seconds between initialisation retries while the sensor is not found
    const RETRY_SECONDS = 30

    function createDeltaMessage (temperature, humidity, pressure, gas_resistance, air_quality_index) {
      const values = [
        { 'path': 'environment.' + options.path1 + '.temperature', 'value': temperature },
        { 'path': 'environment.' + options.path2 + '.humidity', 'value': humidity },
        { 'path': 'environment.' + options.path3 + '.pressure', 'value': pressure },
        { 'path': 'environment.' + options.path4 + '.gas', 'value': gas_resistance }
      ]
      // air quality is only meaningful once a gas baseline exists
      if (air_quality_index !== null) {
        values.push({ 'path': 'environment.' + options.path4 + '.airquality', 'value': air_quality_index })
      }
      return {
        'context': 'vessels.' + app.selfId,
        'updates': [
          {
            'source': {
              'label': plugin.id
            },
            'timestamp': (new Date()).toISOString(),
            'values': values
          }
        ]
      }
    }

    const bme680 = new Bme680(options.i2c_bus || 1, Number(options.i2c_address || '0x77'));
    //const bme680 = new Bme680(1, 0x77);

    let gas_baseline = null
    let burn_in_data = []
    let failing = false

    // Read the sensor once and convert to Signal K units. Returns null on failure.
    // On failure nothing is published: null values would override other sources
    // for the same paths while the sensor is missing.
    async function read () {
      try {
        const sensorData = await bme680.getSensorData()
        if (failing) {
          failing = false
          setStatus('Reading BME680 at ' + options.i2c_address)
        }
        return {
          temperature: sensorData.data.temperature + 273.15,
          pressure: sensorData.data.pressure * 100,
          humidity: sensorData.data.humidity / 100,
          gas_resistance: sensorData.data.gas_resistance
        }
      } catch (err) {
        if (!failing) {
          failing = true
          setError('BME680 read failed: ' + (err && err.message ? err.message : err))
        }
        return null
      }
    }

    function airQualityIndex (humidity, gas_resistance) {
      if (!Number.isFinite(gas_baseline) || gas_baseline <= 0) return null
      const hum_offset = humidity - options.hum_baseline
      const gas_offset = gas_baseline - gas_resistance
      let hum_score, gas_score

      // calculate hum_score as the distance from the hum_baseline
      if (hum_offset > 0) {
        hum_score = (100 - options.hum_baseline - hum_offset) / (100 - options.hum_baseline) * (options.hum_weighting)
      } else {
        hum_score = (options.hum_baseline + hum_offset) / options.hum_baseline * (options.hum_weighting)
      }

      // calculate gas_score as the distance from the gas_baseline
      if (gas_offset > 0) {
        gas_score = (gas_resistance / gas_baseline) * (100 - options.hum_weighting)
      } else {
        gas_score = 100 - options.hum_weighting
      }

      // calculate air_quality_score and convert to Air Quality Index
      return Math.round(500 - (5 * (hum_score + gas_score)))
    }

    // Sensor initialization and burn in periode. Retries while the sensor is missing.
    function SensorBurnIn () {
      bme680.initialize().then(() => {
        if (!running) return
        app.debug('BME680 Sensor initialized')
        setStatus('Burn-in (' + options.burn_in_time + ' s)')
        burn_in_data = []
        burnin = setInterval(async () => {
          const r = await read()
          if (!r) return
          if (Number.isFinite(r.gas_resistance)) burn_in_data.push(r.gas_resistance)
          app.handleMessage(plugin.id, createDeltaMessage(r.temperature, r.humidity, r.pressure, r.gas_resistance, null))
        }, 1000)
        later(EndBurnIn, options.burn_in_time * 1000)
      })
      .catch((err) => {
        if (!running) return
        app.debug('Unable to initialize BME680: ' + (err && err.message ? err.message : err))
        setError('BME680 not found on I2C bus ' + options.i2c_bus + ' at address ' + options.i2c_address + '; retrying every ' + RETRY_SECONDS + ' s')
        later(SensorBurnIn, RETRY_SECONDS * 1000)
      })
    }

    // End of the burn in periode
    function EndBurnIn () {
      const samples = burn_in_data.slice(-50)
      if (samples.length === 0) {
        // no gas readings yet (sensor missing or failing): keep burning in instead of
        // throwing "Reduce of empty array with no initial value"
        app.debug('BME680 burn-in produced no gas readings; extending burn-in')
        later(EndBurnIn, options.burn_in_time * 1000)
        return
      }
      // calculate gas baseline
      gas_baseline = samples.reduce((a, b) => a + b, 0) / samples.length
      // stop the burn in
      clearInterval(burnin)
      burnin = null
      setStatus('Reading BME680 at ' + options.i2c_address)
      readSensorData()
    }

    // Read BME680 sensor data
    function readSensorData () {
      timers.push(setInterval(async () => {
        const r = await read()
        if (!r) return
        app.handleMessage(plugin.id, createDeltaMessage(r.temperature, r.humidity, r.pressure, r.gas_resistance,
          airQualityIndex(r.humidity, r.gas_resistance)))
      }, options.rate * 1000))
    }

    app.debug("Started Plugin BME680");
    SensorBurnIn();
  }

  plugin.stop = function () {
    running = false
    if (burnin) {
      clearInterval(burnin)
      burnin = null
    }
    for (const t of timers) {
      clearTimeout(t)
      clearInterval(t)
    }
    timers = []
  }

  return plugin
}

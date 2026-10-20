# Changelog

## Unreleased

### Fixed
- No more `Uncaught exception: TypeError: Reduce of empty array with no initial value` at the end of the burn-in when the sensor delivered no gas readings (sensor missing or failing). The burn-in is extended until readings arrive.
- The plugin no longer publishes `null` for temperature, humidity, pressure, gas and air quality every few seconds when the sensor is missing or a read fails. Those nulls overrode any other source for the same paths (e.g. `environment.outside.pressure`). The failure is now reported once through the plugin status in the admin UI.
- If the sensor is not found at start-up, initialisation is retried every 30 s, so a sensor connected later is picked up without restarting the server.
- `stop()` now clears every timer (burn-in interval, burn-in timeout, read interval, retries). Before, restarting the plugin left the old burn-in running and duplicated deltas; `stop()` also assigned an undeclared `timeout` variable.
- Missing configuration values fall back to the schema defaults. With an empty configuration `rate` was `undefined`, so the read interval fired every millisecond and the paths became `environment.undefined.*`.
- `environment.<path4>.airquality` is only sent once a gas baseline exists (during the burn-in it was sent as `null`).
- Former implicit globals (`temperature`, `burnin`, `hum_score`, ...) are now local variables.

'use strict';

const { MyPlaceIQPlatform, PLATFORM_NAME } = require('./lib/platform');

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, MyPlaceIQPlatform);
};

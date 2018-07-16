'use strict'

const fs = require('fs')
const Promise = require('bluebird')
const randomstring = require('randomstring')

const { Mhub } = require('./mhub')
const { Caddy } = require('./caddy')
const { Mongo } = require('./mongo')
const { loadModules } = require('./module-loader')
const { loadLogsOptions, createLogStream } = require('./logs')
const { ServiceManager } = require('./services')
const { Configurator } = require('./configurator')

Promise.promisifyAll(fs)

const STARTING_PORT = 2828
const SECRET_LENGTH = 12
const RANDOMSTRING_OPTIONS = {
  length: SECRET_LENGTH,
  charset: 'alphabetic'
}

exports.Server = class {
  constructor (modulesFile) {
    this.modulesPromise = loadModules()
    this.mainLogStream = createLogStream('main')
    this.serviceManager = new ServiceManager()

    this.secret = randomstring.generate(RANDOMSTRING_OPTIONS)
    this.protectedMhubPassword = randomstring.generate(RANDOMSTRING_OPTIONS)
    const mhubOptions = { protectedPassword: this.protectedMhubPassword, configurationPassword: this.secret }
    this.mhub = new Mhub(this.serviceManager, createLogStream('mhub'), mhubOptions)
    this.caddy = new Caddy(this.serviceManager, createLogStream('caddy'))
    this.mongo = new Mongo(this.serviceManager, createLogStream('mongo'))

    this.configurator = new Configurator(this.mhub)

    this.modulesPromise
      .map(module => this.configurator.addModule(module))
      .then(() => this.configurator.seal())
      .catch(err => console.error(err))

    this.modulesStopFunctionsPromise = Promise.resolve([])
  }

  start () {
    return Promise.all([
      this.modulesPromise,
      loadLogsOptions(),
      this.getPortsAllocation(),
      this.mhub.start()
        .then(() => this.configurator.start()),
      this.mongo.start()
    ])
      .then(([modules, logsOptions, portsAllocations]) => modules
        .map((module, i) => module.start(Object.assign({
          port: portsAllocations[module.name],
          secret: this.secret,
          protectedMhubPassword: this.protectedMhubPassword,
          logStream: this.mainLogStream
        }, logsOptions), {
          mhub: this.mhub,
          caddy: this.caddy,
          mongo: this.mongo,
          serviceManager: this.serviceManager,
          portsAllocations
        }))
      )
      .then(stopFunctions => { this.modulesStopFunctionsPromise = Promise.resolve(stopFunctions) })
      .then(() => this.caddy.start())
  }

  restart () {
    return this.close()
      .then(() => this.start())
  }

  close () {
    return this.modulesStopFunctionsPromise
      .map(stop => {
        stop()
      })
      .then(() => [
        this.caddy.stop(),
        this.mongo.stop(),
        this.mhub.stop()
      ])
  }

  getModules () {
    return this.modulesPromise
  }

  getPortsAllocation () {
    return this.modulesPromise
      .then(modules => modules.map(m => m.name)
        .sort()
        .map((name, index) => ({ [name]: STARTING_PORT + index }))
        .reduce((object, keyValue) => Object.assign(object, keyValue), {})
      )
  }
}

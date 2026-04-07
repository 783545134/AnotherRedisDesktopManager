const { contextBridge, ipcRenderer } = require('electron')

const CONNECTIONS_TEST = 'connections:test'
const REDIS_LIST_DATABASES = 'redis:listDatabases'
const REDIS_SCAN_KEYS = 'redis:scanKeys'
const REDIS_GET_KEY_DETAIL = 'redis:getKeyDetail'
const REDIS_SET_STRING_VALUE = 'redis:setStringValue'
const REDIS_SET_KEY_TTL = 'redis:setKeyTtl'
const REDIS_PERSIST_KEY = 'redis:persistKey'
const REDIS_DELETE_KEY = 'redis:deleteKey'
const REDIS_EXECUTE_COMMAND = 'redis:executeCommand'
const REDIS_SAVE_KEY_VALUE = 'redis:saveKeyValue'

function toSerializable(input) {
  return JSON.parse(JSON.stringify(input ?? null))
}

contextBridge.exposeInMainWorld('ardmApi', {
  app: {
    getVersion: () => process.versions.electron,
    getPlatform: () => process.platform,
  },
  connections: {
    test: (connection) => ipcRenderer.invoke(CONNECTIONS_TEST, toSerializable(connection)),
  },
  redis: {
    listDatabases: (connection) => ipcRenderer.invoke(REDIS_LIST_DATABASES, toSerializable(connection)),
    scanKeys: (payload) => ipcRenderer.invoke(REDIS_SCAN_KEYS, toSerializable(payload)),
    getKeyDetail: (payload) => ipcRenderer.invoke(REDIS_GET_KEY_DETAIL, toSerializable(payload)),
    setStringValue: (payload) => ipcRenderer.invoke(REDIS_SET_STRING_VALUE, toSerializable(payload)),
    setKeyTtl: (payload) => ipcRenderer.invoke(REDIS_SET_KEY_TTL, toSerializable(payload)),
    persistKey: (payload) => ipcRenderer.invoke(REDIS_PERSIST_KEY, toSerializable(payload)),
    deleteKey: (payload) => ipcRenderer.invoke(REDIS_DELETE_KEY, toSerializable(payload)),
    executeCommand: (payload) => ipcRenderer.invoke(REDIS_EXECUTE_COMMAND, toSerializable(payload)),
    saveKeyValue: (payload) => ipcRenderer.invoke(REDIS_SAVE_KEY_VALUE, toSerializable(payload)),
  },
})

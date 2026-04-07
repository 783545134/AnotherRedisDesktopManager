const STORAGE_KEYS = {
  CONNECTIONS: 'connections',
  STORAGE_VERSION: 'app_storage_version',
  BACKUP_PREFIX: 'connections_backup_v',
}

const CURRENT_STORAGE_VERSION = 1

function randomString(length = 5) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < length; i += 1) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

function safeParse(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback
  } catch {
    return fallback
  }
}

function normalizeConnection(input = {}) {
  const connection = {
    host: input.host || '127.0.0.1',
    port: Number(input.port || 6379),
    auth: input.auth || '',
    username: input.username || '',
    name: input.name || '',
    separator: input.separator ?? ':',
    cluster: !!input.cluster,
    connectionReadOnly: !!input.connectionReadOnly,
    sshOptions: input.sshOptions
      ? {
          host: input.sshOptions.host || '',
          port: Number(input.sshOptions.port || 22),
          username: input.sshOptions.username || '',
          password: input.sshOptions.password || '',
          privatekey: input.sshOptions.privatekey || '',
          passphrase: input.sshOptions.passphrase || '',
          timeout: Number(input.sshOptions.timeout || 30),
        }
      : undefined,
    sslOptions: input.sslOptions
      ? {
          key: input.sslOptions.key || '',
          cert: input.sslOptions.cert || '',
          ca: input.sslOptions.ca || '',
          servername: input.sslOptions.servername || '',
        }
      : undefined,
    sentinelOptions: input.sentinelOptions
      ? {
          masterName: input.sentinelOptions.masterName || 'mymaster',
          nodePassword: input.sentinelOptions.nodePassword || '',
        }
      : undefined,
  }

  if (input.key) {
    connection.key = input.key
  }

  if (!Number.isNaN(Number(input.order))) {
    connection.order = Number(input.order)
  }

  return connection
}

function getConnectionName(connection) {
  return connection.name || `${connection.host}@${connection.port}`
}

function getConnectionKey(connection, forceUnique = false) {
  if (!connection || Object.keys(connection).length === 0) {
    return ''
  }

  if (!forceUnique && connection.key) {
    return connection.key
  }

  if (forceUnique) {
    return `${Date.now()}_${randomString(5)}`
  }

  return `${connection.host}${connection.port}${getConnectionName(connection)}`
}

function loadConnectionsMap() {
  return safeParse(localStorage.getItem(STORAGE_KEYS.CONNECTIONS), {})
}

function saveConnectionsMap(map) {
  localStorage.setItem(STORAGE_KEYS.CONNECTIONS, JSON.stringify(map))
}

function sortConnections(list) {
  return [...list].sort((a, b) => {
    if (!Number.isNaN(Number(a.order)) && !Number.isNaN(Number(b.order))) {
      return Number(a.order) - Number(b.order)
    }

    if (a.key && b.key) {
      return a.key < b.key ? -1 : 1
    }

    return 0
  })
}

function migrateIfNeeded() {
  const rawVersion = Number(localStorage.getItem(STORAGE_KEYS.STORAGE_VERSION) || 0)
  if (rawVersion >= CURRENT_STORAGE_VERSION) {
    return
  }

  const currentRaw = localStorage.getItem(STORAGE_KEYS.CONNECTIONS)
  localStorage.setItem(`${STORAGE_KEYS.BACKUP_PREFIX}${rawVersion}`, currentRaw || '{}')

  const oldMap = loadConnectionsMap()
  const migrated = {}

  Object.keys(oldMap).forEach((oldKey) => {
    const normalized = normalizeConnection(oldMap[oldKey])
    normalized.name = getConnectionName(normalized)
    normalized.key = getConnectionKey(normalized, true)
    migrated[normalized.key] = normalized
  })

  saveConnectionsMap(migrated)
  localStorage.setItem(STORAGE_KEYS.STORAGE_VERSION, String(CURRENT_STORAGE_VERSION))
}

function listConnections() {
  migrateIfNeeded()
  const map = loadConnectionsMap()
  const list = Object.keys(map).map((key) => normalizeConnection(map[key]))
  return sortConnections(list)
}

function upsertConnection(connection, oldKey = '') {
  migrateIfNeeded()
  const map = loadConnectionsMap()
  const normalized = normalizeConnection(connection)

  const targetOldKey = normalized.key || oldKey
  if (targetOldKey) {
    delete map[targetOldKey]
  }

  const duplicatedName = Object.keys(map).some((key) => getConnectionName(map[key]) === getConnectionName(normalized))
  if (duplicatedName) {
    normalized.name = `${getConnectionName(normalized)} (${randomString(3)})`
  }

  const newKey = getConnectionKey(normalized, true)
  normalized.key = newKey

  if (Number.isNaN(Number(normalized.order))) {
    const maxOrder = Math.max(0, ...Object.values(map).map((item) => Number(item.order || 0)))
    normalized.order = maxOrder + 1
  }

  map[newKey] = normalized
  saveConnectionsMap(map)
  return normalized
}

function deleteConnection(connectionKey) {
  migrateIfNeeded()
  const map = loadConnectionsMap()
  delete map[connectionKey]
  saveConnectionsMap(map)
}

function exportConnections() {
  const list = listConnections()
  return {
    version: CURRENT_STORAGE_VERSION,
    exportedAt: new Date().toISOString(),
    connections: list,
  }
}

function importConnections(payload, mode = 'merge') {
  migrateIfNeeded()

  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.connections)
      ? payload.connections
      : []

  if (!items.length) {
    return { imported: 0, skipped: 0 }
  }

  const map = mode === 'replace' ? {} : loadConnectionsMap()
  let imported = 0
  let skipped = 0

  items.forEach((item) => {
    if (!item || !item.host) {
      skipped += 1
      return
    }

    const normalized = normalizeConnection(item)
    normalized.name = getConnectionName(normalized)

    const duplicatedName = Object.keys(map).some((key) => getConnectionName(map[key]) === getConnectionName(normalized))
    if (duplicatedName) {
      normalized.name = `${getConnectionName(normalized)} (${randomString(3)})`
    }

    const newKey = getConnectionKey(normalized, true)
    normalized.key = newKey

    if (Number.isNaN(Number(normalized.order))) {
      const maxOrder = Math.max(0, ...Object.values(map).map((line) => Number(line.order || 0)))
      normalized.order = maxOrder + 1
    }

    map[newKey] = normalized
    imported += 1
  })

  saveConnectionsMap(map)
  return { imported, skipped }
}

export const connectionStorage = {
  listConnections,
  upsertConnection,
  deleteConnection,
  normalizeConnection,
  exportConnections,
  importConnections,
}

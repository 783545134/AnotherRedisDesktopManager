const { app, BrowserWindow, shell, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const Redis = require('ioredis')
const { createTunnel } = require('tunnel-ssh')
const {
  CONNECTIONS_TEST,
  REDIS_LIST_DATABASES,
  REDIS_SCAN_KEYS,
  REDIS_GET_KEY_DETAIL,
  REDIS_SET_STRING_VALUE,
  REDIS_SET_KEY_TTL,
  REDIS_PERSIST_KEY,
  REDIS_DELETE_KEY,
  REDIS_EXECUTE_COMMAND,
  REDIS_SAVE_KEY_VALUE,
} = require('../../../packages/shared/src/ipc-channels')

function detectErrorCode(raw = '') {
  if (raw.includes('NOAUTH')) return 'AUTH_REQUIRED'
  if (raw.includes('WRONGPASS')) return 'AUTH_INVALID'
  if (raw.includes('ENOTFOUND')) return 'HOST_NOT_FOUND'
  if (raw.includes('ECONNREFUSED')) return 'CONNECTION_REFUSED'
  if (raw.includes('ETIMEDOUT')) return 'TIMEOUT'
  if (raw.includes('All sentinels are unreachable')) return 'SENTINEL_UNREACHABLE'
  if (raw.includes('ERR No such master')) return 'SENTINEL_MASTER_NOT_FOUND'
  return 'UNKNOWN_ERROR'
}

function toUserMessage(mode, code, raw) {
  if (code === 'AUTH_REQUIRED') return `[${mode}] 认证失败：需要密码`
  if (code === 'AUTH_INVALID') return `[${mode}] 认证失败：用户名或密码错误`
  if (code === 'HOST_NOT_FOUND') return `[${mode}] 主机名解析失败`
  if (code === 'CONNECTION_REFUSED') return `[${mode}] 连接被拒绝`
  if (code === 'TIMEOUT') return `[${mode}] 连接超时`
  if (code === 'SENTINEL_UNREACHABLE') return `[${mode}] Sentinel 不可达`
  if (code === 'SENTINEL_MASTER_NOT_FOUND') return `[${mode}] Sentinel masterName 不存在`
  return `[${mode}] ${raw || '连接失败'}`
}

function buildSuccess(mode, message = 'Redis 连接成功') {
  return { ok: true, mode, code: 'OK', message: `[${mode}] ${message}`, raw: '' }
}

function buildFailure(mode, error, forcedCode = '') {
  const raw = error?.message || '连接失败'
  const code = forcedCode || detectErrorCode(raw)
  return { ok: false, mode, code, message: toUserMessage(mode, code, raw), raw }
}

function readOptionalFile(filePath) {
  if (!filePath) {
    return undefined
  }

  try {
    return fs.readFileSync(filePath)
  } catch {
    return filePath
  }
}

function buildTlsOptions(connection = {}) {
  if (!connection.sslOptions) {
    return undefined
  }

  const { key, cert, ca, servername } = connection.sslOptions
  const tlsOptions = {}

  if (key) tlsOptions.key = readOptionalFile(key)
  if (cert) tlsOptions.cert = readOptionalFile(cert)
  if (ca) tlsOptions.ca = readOptionalFile(ca)
  if (servername) tlsOptions.servername = servername

  return Object.keys(tlsOptions).length ? tlsOptions : {}
}

function buildCommonRedisOptions(connection = {}) {
  const options = {
    connectTimeout: 3000,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    retryStrategy: null,
  }

  if (connection.username) {
    options.username = connection.username
  }

  if (connection.auth) {
    options.password = connection.auth
  }

  const tls = buildTlsOptions(connection)
  if (tls) {
    options.tls = tls
  }

  return options
}

function buildStandaloneOptions(connection = {}) {
  return {
    ...buildCommonRedisOptions(connection),
    host: connection.host || '127.0.0.1',
    port: Number(connection.port || 6379),
  }
}

function buildSentinelOptions(connection = {}) {
  const host = connection.host || '127.0.0.1'
  const port = Number(connection.port || 6379)
  const masterName = connection?.sentinelOptions?.masterName || 'mymaster'

  return {
    ...buildCommonRedisOptions(connection),
    sentinels: [{ host, port }],
    name: masterName,
    sentinelPassword: connection.auth || undefined,
    password: connection?.sentinelOptions?.nodePassword || connection.auth || undefined,
  }
}

function buildClusterOptions(connection = {}) {
  return {
    redisOptions: buildCommonRedisOptions(connection),
    slotsRefreshTimeout: 5000,
    enableReadyCheck: false,
  }
}

function buildSshConfig(connection = {}) {
  const ssh = connection.sshOptions || {}

  return {
    tunnelOptions: { autoClose: true },
    serverOptions: {},
    sshOptions: {
      host: ssh.host,
      port: Number(ssh.port || 22),
      username: ssh.username,
      password: ssh.password || undefined,
      privateKey: readOptionalFile(ssh.privatekey),
      passphrase: ssh.passphrase || undefined,
      readyTimeout: Number(ssh.timeout || 30) * 1000,
      keepaliveInterval: 10000,
    },
    forwardOptions: {
      dstAddr: connection.host || '127.0.0.1',
      dstPort: Number(connection.port || 6379),
    },
  }
}

async function withSshTunnel(connection, handler) {
  const sshConfig = buildSshConfig(connection)
  const [server] = await createTunnel(...Object.values(sshConfig))
  const addr = server.address()

  try {
    return await handler({
      ...connection,
      host: addr.address,
      port: addr.port,
    })
  } finally {
    server.close()
  }
}

async function testStandalone(connection) {
  const mode = 'Standalone'
  const redis = new Redis(buildStandaloneOptions(connection))
  try {
    await redis.connect()
    await redis.ping()
    return buildSuccess(mode)
  } catch (error) {
    return buildFailure(mode, error)
  } finally {
    redis.disconnect()
  }
}

async function testSentinel(connection) {
  const mode = 'Sentinel'
  const redis = new Redis(buildSentinelOptions(connection))
  try {
    await redis.connect()
    await redis.ping()
    return buildSuccess(mode)
  } catch (error) {
    return buildFailure(mode, error)
  } finally {
    redis.disconnect()
  }
}

async function testCluster(connection) {
  const mode = 'Cluster'
  const host = connection.host || '127.0.0.1'
  const port = Number(connection.port || 6379)
  const cluster = new Redis.Cluster([{ host, port }], buildClusterOptions(connection))

  try {
    await cluster.connect()
    await cluster.ping()
    return buildSuccess(mode)
  } catch (error) {
    return buildFailure(mode, error)
  } finally {
    cluster.disconnect()
  }
}

async function runRedisAction(connection, action) {
  if (connection?.sshOptions?.host) {
    try {
      return await withSshTunnel(connection, action)
    } catch (error) {
      return buildFailure('SSH', error)
    }
  }

  return action(connection)
}

async function testRedisConnection(connection) {
  const runByMode = async (target) => {
    if (target?.sentinelOptions) {
      return testSentinel(target)
    }

    if (target?.cluster) {
      return testCluster(target)
    }

    return testStandalone(target)
  }

  return runRedisAction(connection, runByMode)
}

async function listDatabases(connection) {
  const mode = 'Standalone'

  const action = async (target) => {
    const redis = new Redis(buildStandaloneOptions(target))
    try {
      await redis.connect()
      const sizeRaw = await redis.config('GET', 'databases')
      const dbCount = Number(Array.isArray(sizeRaw) ? sizeRaw[1] : 16) || 16
      const databases = Array.from({ length: dbCount }, (_, index) => index)
      return { ok: true, mode, code: 'OK', message: `[${mode}] 数据库列表获取成功`, raw: '', databases }
    } catch (error) {
      return { ...buildFailure(mode, error), databases: [] }
    } finally {
      redis.disconnect()
    }
  }

  return runRedisAction(connection, action)
}

async function scanKeys(payload = {}) {
  const connection = payload.connection || {}
  const mode = 'Standalone'

  const action = async (target) => {
    const redis = new Redis(buildStandaloneOptions(target))
    try {
      await redis.connect()
      const db = Number(payload.db || 0)
      const cursor = String(payload.cursor || '0')
      const count = Number(payload.count || 100)
      const match = payload.match || '*'

      await redis.select(db)
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', match, 'COUNT', count)

      return {
        ok: true,
        mode,
        code: 'OK',
        message: `[${mode}] Key 扫描成功`,
        raw: '',
        data: {
          cursor: String(nextCursor || '0'),
          keys: Array.isArray(keys) ? keys : [],
          db,
          match,
          count,
        },
      }
    } catch (error) {
      return {
        ...buildFailure(mode, error),
        data: {
          cursor: String(payload.cursor || '0'),
          keys: [],
          db: Number(payload.db || 0),
          match: payload.match || '*',
          count: Number(payload.count || 100),
        },
      }
    } finally {
      redis.disconnect()
    }
  }

  return runRedisAction(connection, action)
}

async function getKeyDetail(payload = {}) {
  const connection = payload.connection || {}
  const mode = 'Standalone'

  const action = async (target) => {
    const redis = new Redis(buildStandaloneOptions(target))
    try {
      await redis.connect()
      const db = Number(payload.db || 0)
      const key = String(payload.key || '')

      if (!key) {
        return {
          ok: false,
          mode: 'Validation',
          code: 'INVALID_KEY',
          message: '[Validation] key 不能为空',
          raw: '',
          data: { db, key, type: '', ttl: -1, value: '' },
        }
      }

      await redis.select(db)
      const [type, ttl] = await Promise.all([redis.type(key), redis.pttl(key)])

      let value = ''
      if (type === 'string') {
        const text = await redis.get(key)
        value = text ?? ''
      } else if (type === 'hash') {
        value = await redis.hgetall(key)
      } else if (type === 'list') {
        value = await redis.lrange(key, 0, -1)
      } else if (type === 'set') {
        value = await redis.smembers(key)
      } else if (type === 'zset') {
        const rows = await redis.zrange(key, 0, -1, 'WITHSCORES')
        value = []
        for (let i = 0; i < rows.length; i += 2) {
          value.push({ member: String(rows[i] ?? ''), score: Number(rows[i + 1] ?? 0) })
        }
      } else {
        value = `[${type}] 暂不支持编辑，当前只读展示`
      }

      return {
        ok: true,
        mode,
        code: 'OK',
        message: `[${mode}] Key 详情获取成功`,
        raw: '',
        data: {
          db,
          key,
          type,
          ttl,
          value,
        },
      }
    } catch (error) {
      return {
        ...buildFailure(mode, error),
        data: {
          db: Number(payload.db || 0),
          key: String(payload.key || ''),
          type: '',
          ttl: -1,
          value: '',
        },
      }
    } finally {
      redis.disconnect()
    }
  }

  return runRedisAction(connection, action)
}

async function setStringValue(payload = {}) {
  const connection = payload.connection || {}
  const mode = 'Standalone'

  const action = async (target) => {
    const redis = new Redis(buildStandaloneOptions(target))
    try {
      await redis.connect()
      const db = Number(payload.db || 0)
      const key = String(payload.key || '')
      const value = String(payload.value ?? '')

      if (!key) {
        return {
          ok: false,
          mode: 'Validation',
          code: 'INVALID_KEY',
          message: '[Validation] key 不能为空',
          raw: '',
          data: { db, key, type: '', ttl: -1, value: '' },
        }
      }

      await redis.select(db)
      const keyType = await redis.type(key)
      if (keyType !== 'string') {
        return {
          ok: false,
          mode: 'Validation',
          code: 'TYPE_NOT_STRING',
          message: `[Validation] ${key} 不是 string 类型，无法直接写入`,
          raw: '',
          data: { db, key, type: keyType, ttl: -1, value: '' },
        }
      }

      await redis.set(key, value)
      const [type, ttl, latestValue] = await Promise.all([redis.type(key), redis.pttl(key), redis.get(key)])

      return {
        ok: true,
        mode,
        code: 'OK',
        message: `[${mode}] String 值保存成功`,
        raw: '',
        data: {
          db,
          key,
          type,
          ttl,
          value: latestValue ?? '',
        },
      }
    } catch (error) {
      return {
        ...buildFailure(mode, error),
        data: {
          db: Number(payload.db || 0),
          key: String(payload.key || ''),
          type: '',
          ttl: -1,
          value: '',
        },
      }
    } finally {
      redis.disconnect()
    }
  }

  return runRedisAction(connection, action)
}

async function setKeyTtl(payload = {}) {
  const connection = payload.connection || {}
  const mode = 'Standalone'

  const action = async (target) => {
    const redis = new Redis(buildStandaloneOptions(target))
    try {
      await redis.connect()
      const db = Number(payload.db || 0)
      const key = String(payload.key || '')
      const ttl = Number(payload.ttl ?? -1)

      if (!key) {
        return {
          ok: false,
          mode: 'Validation',
          code: 'INVALID_KEY',
          message: '[Validation] key 不能为空',
          raw: '',
          data: { db, key, ttl: -1 },
        }
      }

      if (!Number.isFinite(ttl) || ttl <= 0) {
        return {
          ok: false,
          mode: 'Validation',
          code: 'INVALID_TTL',
          message: '[Validation] TTL 必须是大于 0 的毫秒值',
          raw: '',
          data: { db, key, ttl: -1 },
        }
      }

      await redis.select(db)
      await redis.pexpire(key, ttl)
      const latestTtl = await redis.pttl(key)

      return {
        ok: true,
        mode,
        code: 'OK',
        message: `[${mode}] TTL 设置成功`,
        raw: '',
        data: { db, key, ttl: Number(latestTtl) },
      }
    } catch (error) {
      return {
        ...buildFailure(mode, error),
        data: {
          db: Number(payload.db || 0),
          key: String(payload.key || ''),
          ttl: -1,
        },
      }
    } finally {
      redis.disconnect()
    }
  }

  return runRedisAction(connection, action)
}

async function persistKey(payload = {}) {
  const connection = payload.connection || {}
  const mode = 'Standalone'

  const action = async (target) => {
    const redis = new Redis(buildStandaloneOptions(target))
    try {
      await redis.connect()
      const db = Number(payload.db || 0)
      const key = String(payload.key || '')

      if (!key) {
        return {
          ok: false,
          mode: 'Validation',
          code: 'INVALID_KEY',
          message: '[Validation] key 不能为空',
          raw: '',
          data: { db, key, ttl: -1 },
        }
      }

      await redis.select(db)
      await redis.persist(key)
      const latestTtl = await redis.pttl(key)

      return {
        ok: true,
        mode,
        code: 'OK',
        message: `[${mode}] 已移除过期时间`,
        raw: '',
        data: { db, key, ttl: Number(latestTtl) },
      }
    } catch (error) {
      return {
        ...buildFailure(mode, error),
        data: {
          db: Number(payload.db || 0),
          key: String(payload.key || ''),
          ttl: -1,
        },
      }
    } finally {
      redis.disconnect()
    }
  }

  return runRedisAction(connection, action)
}

async function deleteKey(payload = {}) {
  const connection = payload.connection || {}
  const mode = 'Standalone'

  const action = async (target) => {
    const redis = new Redis(buildStandaloneOptions(target))
    try {
      await redis.connect()
      const db = Number(payload.db || 0)
      const key = String(payload.key || '')

      if (!key) {
        return {
          ok: false,
          mode: 'Validation',
          code: 'INVALID_KEY',
          message: '[Validation] key 不能为空',
          raw: '',
          data: { db, key, deleted: 0 },
        }
      }

      await redis.select(db)
      const deleted = Number(await redis.del(key) || 0)

      return {
        ok: true,
        mode,
        code: 'OK',
        message: deleted > 0 ? `[${mode}] Key 删除成功` : `[${mode}] Key 不存在或已删除`,
        raw: '',
        data: { db, key, deleted },
      }
    } catch (error) {
      return {
        ...buildFailure(mode, error),
        data: {
          db: Number(payload.db || 0),
          key: String(payload.key || ''),
          deleted: 0,
        },
      }
    } finally {
      redis.disconnect()
    }
  }

  return runRedisAction(connection, action)
}

function parseCommandLine(input = '') {
  const source = String(input || '').trim()
  if (!source) {
    return []
  }

  const parts = []
  const matched = source.match(/"(?:\\"|[^"])*"|'(?:\\'|[^'])*'|\S+/g) || []

  for (const item of matched) {
    if ((item.startsWith('"') && item.endsWith('"')) || (item.startsWith("'") && item.endsWith("'"))) {
      parts.push(item.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'"))
    } else {
      parts.push(item)
    }
  }

  return parts
}

async function executeCommand(payload = {}) {
  const connection = payload.connection || {}
  const mode = 'Standalone'

  const action = async (target) => {
    const redis = new Redis(buildStandaloneOptions(target))
    try {
      await redis.connect()
      const db = Number(payload.db || 0)
      const line = String(payload.command || '')
      const parts = parseCommandLine(line)

      if (!parts.length) {
        return {
          ok: false,
          mode: 'Validation',
          code: 'EMPTY_COMMAND',
          message: '[Validation] 命令不能为空',
          raw: '',
          data: { db, command: '', args: [], result: null },
        }
      }

      const [command, ...args] = parts
      await redis.select(db)
      const result = await redis.call(command, ...args)

      return {
        ok: true,
        mode,
        code: 'OK',
        message: `[${mode}] 命令执行成功`,
        raw: '',
        data: { db, command: command.toUpperCase(), args, result },
      }
    } catch (error) {
      return {
        ...buildFailure(mode, error),
        data: {
          db: Number(payload.db || 0),
          command: String(payload.command || ''),
          args: [],
          result: null,
        },
      }
    } finally {
      redis.disconnect()
    }
  }

  return runRedisAction(connection, action)
}

async function saveKeyValue(payload = {}) {
  const connection = payload.connection || {}
  const mode = 'Standalone'

  const action = async (target) => {
    const redis = new Redis(buildStandaloneOptions(target))
    try {
      await redis.connect()
      const db = Number(payload.db || 0)
      const key = String(payload.key || '')
      const type = String(payload.type || '')
      const value = payload.value

      if (!key) {
        return {
          ok: false,
          mode: 'Validation',
          code: 'INVALID_KEY',
          message: '[Validation] key 不能为空',
          raw: '',
          data: { db, key, type: '', ttl: -1, value: '' },
        }
      }

      await redis.select(db)
      const currentType = await redis.type(key)
      if (currentType !== type) {
        return {
          ok: false,
          mode: 'Validation',
          code: 'TYPE_MISMATCH',
          message: `[Validation] 类型不匹配，当前是 ${currentType}`,
          raw: '',
          data: { db, key, type: currentType, ttl: -1, value: '' },
        }
      }

      if (type === 'string') {
        await redis.set(key, String(value ?? ''))
      } else if (type === 'hash') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return {
            ok: false,
            mode: 'Validation',
            code: 'INVALID_HASH_VALUE',
            message: '[Validation] hash 需要对象格式',
            raw: '',
            data: { db, key, type, ttl: -1, value: {} },
          }
        }
        await redis.del(key)
        const fields = Object.entries(value).flatMap(([field, fieldValue]) => [field, String(fieldValue ?? '')])
        if (fields.length) {
          await redis.hset(key, ...fields)
        }
      } else if (type === 'list') {
        if (!Array.isArray(value)) {
          return {
            ok: false,
            mode: 'Validation',
            code: 'INVALID_LIST_VALUE',
            message: '[Validation] list 需要数组格式',
            raw: '',
            data: { db, key, type, ttl: -1, value: [] },
          }
        }
        await redis.del(key)
        if (value.length) {
          await redis.rpush(key, ...value.map((item) => String(item ?? '')))
        }
      } else if (type === 'set') {
        if (!Array.isArray(value)) {
          return {
            ok: false,
            mode: 'Validation',
            code: 'INVALID_SET_VALUE',
            message: '[Validation] set 需要数组格式',
            raw: '',
            data: { db, key, type, ttl: -1, value: [] },
          }
        }
        await redis.del(key)
        if (value.length) {
          await redis.sadd(key, ...value.map((item) => String(item ?? '')))
        }
      } else if (type === 'zset') {
        if (!Array.isArray(value)) {
          return {
            ok: false,
            mode: 'Validation',
            code: 'INVALID_ZSET_VALUE',
            message: '[Validation] zset 需要数组格式',
            raw: '',
            data: { db, key, type, ttl: -1, value: [] },
          }
        }
        const tuples = []
        for (const row of value) {
          const member = String(row?.member ?? '')
          const score = Number(row?.score ?? 0)
          if (!member || !Number.isFinite(score)) {
            return {
              ok: false,
              mode: 'Validation',
              code: 'INVALID_ZSET_ITEM',
              message: '[Validation] zset 项必须包含 member 和数值 score',
              raw: '',
              data: { db, key, type, ttl: -1, value: [] },
            }
          }
          tuples.push(score, member)
        }
        await redis.del(key)
        if (tuples.length) {
          await redis.zadd(key, ...tuples)
        }
      } else {
        return {
          ok: false,
          mode: 'Validation',
          code: 'UNSUPPORTED_TYPE',
          message: `[Validation] 不支持编辑类型 ${type}`,
          raw: '',
          data: { db, key, type, ttl: -1, value: '' },
        }
      }

      const ttl = Number(await redis.pttl(key))
      let latestValue = ''

      if (type === 'string') {
        latestValue = (await redis.get(key)) ?? ''
      } else if (type === 'hash') {
        latestValue = await redis.hgetall(key)
      } else if (type === 'list') {
        latestValue = await redis.lrange(key, 0, -1)
      } else if (type === 'set') {
        latestValue = await redis.smembers(key)
      } else if (type === 'zset') {
        const rows = await redis.zrange(key, 0, -1, 'WITHSCORES')
        latestValue = []
        for (let i = 0; i < rows.length; i += 2) {
          latestValue.push({ member: String(rows[i] ?? ''), score: Number(rows[i + 1] ?? 0) })
        }
      }

      return {
        ok: true,
        mode,
        code: 'OK',
        message: `[${mode}] Key 保存成功`,
        raw: '',
        data: { db, key, type, ttl, value: latestValue },
      }
    } catch (error) {
      return {
        ...buildFailure(mode, error),
        data: {
          db: Number(payload.db || 0),
          key: String(payload.key || ''),
          type: String(payload.type || ''),
          ttl: -1,
          value: '',
        },
      }
    } finally {
      redis.disconnect()
    }
  }

  return runRedisAction(connection, action)
}

function registerIpcHandlers() {
  ipcMain.handle(CONNECTIONS_TEST, async (_event, connection) => {
    const host = connection?.host || '127.0.0.1'
    const port = Number(connection?.port || 6379)

    if (!host || Number.isNaN(port) || port < 1 || port > 65535) {
      return {
        ok: false,
        mode: 'Validation',
        code: 'INVALID_HOST_PORT',
        message: '[Validation] 无效的 host/port',
        raw: '',
      }
    }

    return testRedisConnection(connection)
  })

  ipcMain.handle(REDIS_LIST_DATABASES, async (_event, connection) => {
    const host = connection?.host || '127.0.0.1'
    const port = Number(connection?.port || 6379)

    if (!host || Number.isNaN(port) || port < 1 || port > 65535) {
      return {
        ok: false,
        mode: 'Validation',
        code: 'INVALID_HOST_PORT',
        message: '[Validation] 无效的 host/port',
        raw: '',
        databases: [],
      }
    }

    return listDatabases(connection)
  })

  ipcMain.handle(REDIS_SCAN_KEYS, async (_event, payload) => {
    const connection = payload?.connection || {}
    const host = connection.host || '127.0.0.1'
    const port = Number(connection.port || 6379)

    if (!host || Number.isNaN(port) || port < 1 || port > 65535) {
      return {
        ok: false,
        mode: 'Validation',
        code: 'INVALID_HOST_PORT',
        message: '[Validation] 无效的 host/port',
        raw: '',
        data: {
          cursor: String(payload?.cursor || '0'),
          keys: [],
          db: Number(payload?.db || 0),
          match: payload?.match || '*',
          count: Number(payload?.count || 100),
        },
      }
    }

    return scanKeys(payload)
  })

  ipcMain.handle(REDIS_GET_KEY_DETAIL, async (_event, payload) => {
    const connection = payload?.connection || {}
    const host = connection.host || '127.0.0.1'
    const port = Number(connection.port || 6379)

    if (!host || Number.isNaN(port) || port < 1 || port > 65535) {
      return {
        ok: false,
        mode: 'Validation',
        code: 'INVALID_HOST_PORT',
        message: '[Validation] 无效的 host/port',
        raw: '',
        data: {
          db: Number(payload?.db || 0),
          key: String(payload?.key || ''),
          type: '',
          ttl: -1,
          value: '',
        },
      }
    }

    return getKeyDetail(payload)
  })

  ipcMain.handle(REDIS_SET_STRING_VALUE, async (_event, payload) => {
    const connection = payload?.connection || {}
    const host = connection.host || '127.0.0.1'
    const port = Number(connection.port || 6379)

    if (!host || Number.isNaN(port) || port < 1 || port > 65535) {
      return {
        ok: false,
        mode: 'Validation',
        code: 'INVALID_HOST_PORT',
        message: '[Validation] 无效的 host/port',
        raw: '',
        data: {
          db: Number(payload?.db || 0),
          key: String(payload?.key || ''),
          type: '',
          ttl: -1,
          value: '',
        },
      }
    }

    return setStringValue(payload)
  })

  ipcMain.handle(REDIS_SET_KEY_TTL, async (_event, payload) => {
    const connection = payload?.connection || {}
    const host = connection.host || '127.0.0.1'
    const port = Number(connection.port || 6379)

    if (!host || Number.isNaN(port) || port < 1 || port > 65535) {
      return {
        ok: false,
        mode: 'Validation',
        code: 'INVALID_HOST_PORT',
        message: '[Validation] 无效的 host/port',
        raw: '',
        data: {
          db: Number(payload?.db || 0),
          key: String(payload?.key || ''),
          ttl: -1,
        },
      }
    }

    return setKeyTtl(payload)
  })

  ipcMain.handle(REDIS_PERSIST_KEY, async (_event, payload) => {
    const connection = payload?.connection || {}
    const host = connection.host || '127.0.0.1'
    const port = Number(connection.port || 6379)

    if (!host || Number.isNaN(port) || port < 1 || port > 65535) {
      return {
        ok: false,
        mode: 'Validation',
        code: 'INVALID_HOST_PORT',
        message: '[Validation] 无效的 host/port',
        raw: '',
        data: {
          db: Number(payload?.db || 0),
          key: String(payload?.key || ''),
          ttl: -1,
        },
      }
    }

    return persistKey(payload)
  })

  ipcMain.handle(REDIS_DELETE_KEY, async (_event, payload) => {
    const connection = payload?.connection || {}
    const host = connection.host || '127.0.0.1'
    const port = Number(connection.port || 6379)

    if (!host || Number.isNaN(port) || port < 1 || port > 65535) {
      return {
        ok: false,
        mode: 'Validation',
        code: 'INVALID_HOST_PORT',
        message: '[Validation] 无效的 host/port',
        raw: '',
        data: {
          db: Number(payload?.db || 0),
          key: String(payload?.key || ''),
          deleted: 0,
        },
      }
    }

    return deleteKey(payload)
  })

  ipcMain.handle(REDIS_EXECUTE_COMMAND, async (_event, payload) => {
    const connection = payload?.connection || {}
    const host = connection.host || '127.0.0.1'
    const port = Number(connection.port || 6379)

    if (!host || Number.isNaN(port) || port < 1 || port > 65535) {
      return {
        ok: false,
        mode: 'Validation',
        code: 'INVALID_HOST_PORT',
        message: '[Validation] 无效的 host/port',
        raw: '',
        data: {
          db: Number(payload?.db || 0),
          command: String(payload?.command || ''),
          args: [],
          result: null,
        },
      }
    }

    return executeCommand(payload)
  })

  ipcMain.handle(REDIS_SAVE_KEY_VALUE, async (_event, payload) => {
    const connection = payload?.connection || {}
    const host = connection.host || '127.0.0.1'
    const port = Number(connection.port || 6379)

    if (!host || Number.isNaN(port) || port < 1 || port > 65535) {
      return {
        ok: false,
        mode: 'Validation',
        code: 'INVALID_HOST_PORT',
        message: '[Validation] 无效的 host/port',
        raw: '',
        data: {
          db: Number(payload?.db || 0),
          key: String(payload?.key || ''),
          type: String(payload?.type || ''),
          ttl: -1,
          value: '',
        },
      }
    }

    return saveKeyValue(payload)
  })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, '../../preload/src/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  const devUrl = process.env.ARDM_NEXT_RENDERER_URL
  if (devUrl) {
    win.loadURL(devUrl)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '../../../dist/renderer/index.html'))
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

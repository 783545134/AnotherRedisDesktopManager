<template>
  <section class="connections">
    <h2>Connections</h2>

    <form class="connection-form" @submit.prevent="submitForm">
      <div class="row">
        <label>Host</label>
        <input v-model.trim="form.host" placeholder="127.0.0.1" />
      </div>
      <div class="row">
        <label>Port</label>
        <input v-model.number="form.port" type="number" min="1" max="65535" />
      </div>
      <div class="row">
        <label>Name</label>
        <input v-model.trim="form.name" placeholder="host@port" />
      </div>
      <div class="row">
        <label>Username</label>
        <input v-model.trim="form.username" placeholder="ACL username" />
      </div>
      <div class="row">
        <label>Password</label>
        <input v-model="form.auth" type="password" placeholder="Auth" />
      </div>
      <div class="row row-inline">
        <label><input v-model="form.cluster" type="checkbox" /> Cluster</label>
        <label><input v-model="form.connectionReadOnly" type="checkbox" /> Readonly</label>
        <label><input v-model="sshEnabled" type="checkbox" /> SSH</label>
        <label><input v-model="sslEnabled" type="checkbox" /> SSL</label>
        <label><input v-model="sentinelEnabled" type="checkbox" /> Sentinel</label>
      </div>

      <div v-if="sshEnabled" class="fieldset">
        <h3>SSH Tunnel</h3>
        <div class="row">
          <label>SSH Host</label>
          <input v-model.trim="form.sshOptions.host" placeholder="127.0.0.1" />
        </div>
        <div class="row">
          <label>SSH Port</label>
          <input v-model.number="form.sshOptions.port" type="number" min="1" max="65535" />
        </div>
        <div class="row">
          <label>SSH Username</label>
          <input v-model.trim="form.sshOptions.username" />
        </div>
        <div class="row">
          <label>SSH Password</label>
          <input v-model="form.sshOptions.password" type="password" />
        </div>
        <div class="row">
          <label>Private Key Path</label>
          <input v-model.trim="form.sshOptions.privatekey" placeholder="/path/to/id_rsa" />
        </div>
        <div class="row">
          <label>Passphrase</label>
          <input v-model="form.sshOptions.passphrase" type="password" />
        </div>
        <div class="row">
          <label>Timeout(s)</label>
          <input v-model.number="form.sshOptions.timeout" type="number" min="1" />
        </div>
      </div>

      <div v-if="sslEnabled" class="fieldset">
        <h3>SSL</h3>
        <div class="row">
          <label>Key Path</label>
          <input v-model.trim="form.sslOptions.key" placeholder="/path/to/key.pem" />
        </div>
        <div class="row">
          <label>Cert Path</label>
          <input v-model.trim="form.sslOptions.cert" placeholder="/path/to/cert.pem" />
        </div>
        <div class="row">
          <label>CA Path</label>
          <input v-model.trim="form.sslOptions.ca" placeholder="/path/to/ca.pem" />
        </div>
        <div class="row">
          <label>SNI</label>
          <input v-model.trim="form.sslOptions.servername" placeholder="servername" />
        </div>
      </div>

      <div v-if="sentinelEnabled" class="fieldset">
        <h3>Sentinel</h3>
        <div class="row">
          <label>Master Name</label>
          <input v-model.trim="form.sentinelOptions.masterName" placeholder="mymaster" />
        </div>
        <div class="row">
          <label>Node Password</label>
          <input v-model="form.sentinelOptions.nodePassword" type="password" />
        </div>
      </div>

      <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
      <p v-if="testMessage" :class="testResultOk ? 'success' : 'error'">{{ testMessage }}</p>

      <button type="button" class="secondary" :disabled="testing" @click="testConnection">
        {{ testing ? 'Testing...' : 'Test Connection' }}
      </button>
      <button type="submit">{{ editingKey ? 'Update' : 'Add' }} Connection</button>
      <button v-if="editingKey" type="button" class="secondary" @click="resetForm">Cancel</button>
    </form>

    <div class="toolbar">
      <button type="button" class="secondary" @click="exportToJson">Export JSON</button>
      <button type="button" class="secondary" @click="triggerImport">Import JSON</button>
      <button type="button" class="secondary" @click="triggerReplaceImport">Import & Replace</button>
      <input
        ref="importInputRef"
        class="hidden-input"
        type="file"
        accept="application/json,.json"
        @change="onImportFile"
      />
    </div>

    <ul class="connection-list">
      <li v-for="item in connections" :key="item.key">
        <div>
          <strong>{{ item.name || `${item.host}@${item.port}` }}</strong>
          <div class="meta">{{ item.host }}:{{ item.port }} · {{ item.username || 'default' }}</div>
        </div>
        <div class="actions">
          <button type="button" @click="startEdit(item)">Edit</button>
          <button type="button" class="danger" @click="remove(item.key)">Delete</button>
        </div>
      </li>
    </ul>
  </section>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { connectionStorage } from './storage'

const connections = ref(connectionStorage.listConnections())
const editingKey = ref('')
const sshEnabled = ref(false)
const sslEnabled = ref(false)
const sentinelEnabled = ref(false)
const errorMessage = ref('')
const testMessage = ref('')
const testResultOk = ref(false)
const testing = ref(false)
const importInputRef = ref(null)
const importMode = ref('merge')

const codeMessageMap = {
  OK: '连接成功',
  INVALID_HOST_PORT: '地址或端口不合法',
  AUTH_REQUIRED: '需要认证密码',
  AUTH_INVALID: '用户名或密码错误',
  HOST_NOT_FOUND: '主机名解析失败',
  CONNECTION_REFUSED: '连接被拒绝',
  TIMEOUT: '连接超时',
  SENTINEL_UNREACHABLE: 'Sentinel 节点不可达',
  SENTINEL_MASTER_NOT_FOUND: 'Sentinel masterName 不存在',
}

function formatResponseMessage(response) {
  const code = response?.code || 'UNKNOWN_ERROR'
  const mode = response?.mode || 'Unknown'
  const text = codeMessageMap[code] || response?.message || '连接失败'
  return `[${mode}] ${text}`
}

const initialForm = () => ({
  host: '127.0.0.1',
  port: 6379,
  name: '',
  username: '',
  auth: '',
  separator: ':',
  cluster: false,
  connectionReadOnly: false,
  sshOptions: {
    host: '',
    port: 22,
    username: '',
    password: '',
    privatekey: '',
    passphrase: '',
    timeout: 30,
  },
  sslOptions: {
    key: '',
    cert: '',
    ca: '',
    servername: '',
  },
  sentinelOptions: {
    masterName: 'mymaster',
    nodePassword: '',
  },
})

const form = reactive(initialForm())

function refresh() {
  connections.value = connectionStorage.listConnections()
}

function resetForm() {
  Object.assign(form, initialForm())
  editingKey.value = ''
  sshEnabled.value = false
  sslEnabled.value = false
  sentinelEnabled.value = false
  errorMessage.value = ''
  testMessage.value = ''
  testResultOk.value = false
  testing.value = false
}

function getPayloadForSubmit() {
  if (!form.host) {
    return { ok: false, message: 'Host 不能为空' }
  }

  if (sentinelEnabled.value && form.cluster) {
    return { ok: false, message: 'Sentinel 与 Cluster 不能同时启用' }
  }

  const payload = {
    ...form,
    sshOptions: sshEnabled.value ? { ...form.sshOptions } : undefined,
    sslOptions: sslEnabled.value ? { ...form.sslOptions } : undefined,
    sentinelOptions: sentinelEnabled.value ? { ...form.sentinelOptions } : undefined,
  }

  if (sentinelEnabled.value && !payload.sentinelOptions?.masterName) {
    return { ok: false, message: 'Sentinel 模式必须填写 Master Name' }
  }

  return { ok: true, payload }
}

async function testConnection() {
  const result = getPayloadForSubmit()
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }

  errorMessage.value = ''
  testMessage.value = ''
  testing.value = true

  try {
    const tester = window.ardmApi?.connections?.test
    if (typeof tester !== 'function') {
      testResultOk.value = false
      testMessage.value = '当前运行环境未注入 ardmApi.connections.test，请通过 Electron 启动应用'
      return
    }

    const response = await tester(result.payload)
    testResultOk.value = !!response?.ok
    testMessage.value = response?.ok
      ? response?.message || '连接成功'
      : formatResponseMessage(response)
  } catch (error) {
    testResultOk.value = false
    testMessage.value = error?.message || '连接测试异常'
  } finally {
    testing.value = false
  }
}

function submitForm() {
  const result = getPayloadForSubmit()
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }

  errorMessage.value = ''
  const saved = connectionStorage.upsertConnection(result.payload, editingKey.value)
  editingKey.value = saved.key
  refresh()
  resetForm()
}

function startEdit(item) {
  testMessage.value = ''
  testResultOk.value = false
  Object.assign(form, {
    host: item.host,
    port: item.port,
    name: item.name,
    username: item.username,
    auth: item.auth,
    separator: item.separator,
    cluster: item.cluster,
    connectionReadOnly: item.connectionReadOnly,
    sshOptions: {
      host: item.sshOptions?.host || '',
      port: item.sshOptions?.port || 22,
      username: item.sshOptions?.username || '',
      password: item.sshOptions?.password || '',
      privatekey: item.sshOptions?.privatekey || '',
      passphrase: item.sshOptions?.passphrase || '',
      timeout: item.sshOptions?.timeout || 30,
    },
    sslOptions: {
      key: item.sslOptions?.key || '',
      cert: item.sslOptions?.cert || '',
      ca: item.sslOptions?.ca || '',
      servername: item.sslOptions?.servername || '',
    },
    sentinelOptions: {
      masterName: item.sentinelOptions?.masterName || 'mymaster',
      nodePassword: item.sentinelOptions?.nodePassword || '',
    },
  })
  sshEnabled.value = !!item.sshOptions
  sslEnabled.value = !!item.sslOptions
  sentinelEnabled.value = !!item.sentinelOptions
  editingKey.value = item.key
  errorMessage.value = ''
}

function remove(key) {
  connectionStorage.deleteConnection(key)
  refresh()
  if (editingKey.value === key) {
    resetForm()
  }
}

function exportToJson() {
  const payload = connectionStorage.exportConnections()
  const text = JSON.stringify(payload, null, 2)
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `ardm-connections-${Date.now()}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  testResultOk.value = true
  testMessage.value = `[Export] 已导出 ${payload.connections.length} 条连接`
}

function triggerImport() {
  importMode.value = 'merge'
  importInputRef.value?.click()
}

function triggerReplaceImport() {
  importMode.value = 'replace'
  importInputRef.value?.click()
}

async function onImportFile(event) {
  const file = event.target.files?.[0]
  if (!file) {
    return
  }

  try {
    const content = await file.text()
    const payload = JSON.parse(content)
    const result = connectionStorage.importConnections(payload, importMode.value)
    refresh()
    testResultOk.value = true
    testMessage.value = `[Import] 成功 ${result.imported} 条，跳过 ${result.skipped} 条`
  } catch (error) {
    testResultOk.value = false
    testMessage.value = `[Import] 失败：${error?.message || '文件格式错误'}`
  } finally {
    event.target.value = ''
  }
}
</script>

<style scoped>
.connections {
  margin-top: 16px;
  max-width: 720px;
}

.connection-form {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
}

.row {
  display: grid;
  grid-template-columns: 120px 1fr;
  align-items: center;
  margin-bottom: 10px;
  gap: 10px;
}

.row-inline {
  grid-template-columns: 1fr;
  display: flex;
  gap: 16px;
}

input {
  border: 1px solid #d1d5db;
  border-radius: 6px;
  padding: 6px 10px;
}

button {
  border: 1px solid #2563eb;
  background: #2563eb;
  color: #fff;
  border-radius: 6px;
  padding: 6px 10px;
  cursor: pointer;
  margin-right: 8px;
}

button.secondary {
  border-color: #6b7280;
  background: #6b7280;
}

button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

button.danger {
  border-color: #dc2626;
  background: #dc2626;
}

.fieldset {
  border: 1px dashed #d1d5db;
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
}

.fieldset h3 {
  margin: 0 0 10px;
  font-size: 14px;
}

.error {
  color: #dc2626;
  margin-bottom: 10px;
}

.success {
  color: #059669;
  margin-bottom: 10px;
}

.toolbar {
  margin-bottom: 12px;
}

.hidden-input {
  display: none;
}

.connection-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.connection-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 10px;
}

.meta {
  font-size: 12px;
  color: #6b7280;
  margin-top: 4px;
}

.actions {
  display: flex;
}
</style>

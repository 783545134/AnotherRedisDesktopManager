<template>
  <section class="keys">
    <h2>Key Browser</h2>

    <div class="toolbar">
      <label>
        Connection
        <select v-model="selectedConnectionKey" @change="onConnectionChange">
          <option value="">请选择连接</option>
          <option v-for="item in connections" :key="item.key" :value="item.key">
            {{ item.name || `${item.host}@${item.port}` }}
          </option>
        </select>
      </label>

      <label>
        DB
        <select v-model.number="selectedDb">
          <option v-for="db in databases" :key="db" :value="db">db{{ db }}</option>
        </select>
      </label>

      <label>
        Pattern
        <input v-model.trim="match" placeholder="*" />
      </label>

      <button type="button" :disabled="loading" @click="scanFromStart">Scan</button>
      <button type="button" class="secondary" :disabled="loading || cursor === '0'" @click="scanNext">Next Page</button>
      <button type="button" class="secondary" @click="refreshConnections">Refresh Connections</button>
    </div>

    <p v-if="message" :class="statusOk ? 'success' : 'error'">{{ message }}</p>

    <div class="meta">
      <span>Cursor: {{ cursor }}</span>
      <span>Count: {{ keys.length }}</span>
      <span>DB: {{ selectedDb }}</span>
    </div>

    <ul class="key-list">
      <li
        v-for="key in keys"
        :key="key"
        :class="{ active: key === selectedKey }"
        @click="loadKeyDetail(key)"
      >
        {{ key }}
      </li>
    </ul>

    <div v-if="selectedKey" class="detail">
      <h3>Key Detail</h3>
      <p><strong>Key:</strong> {{ selectedKey }}</p>
      <p><strong>Type:</strong> {{ detail.type || '-' }}</p>
      <p><strong>TTL(ms):</strong> {{ detail.ttl }}</p>
      <label>
        Value
        <textarea v-model="editableValue"></textarea>
      </label>
      <div class="ttl-row">
        <label>
          TTL(ms)
          <input v-model.trim="ttlInput" type="number" min="1" placeholder="例如 60000" />
        </label>
      </div>
      <div class="detail-actions">
        <button type="button" :disabled="loading || !canSaveCurrentType" @click="saveCurrentValue">Save</button>
        <button type="button" :disabled="loading || !ttlInput" @click="applyTtl">Set TTL</button>
        <button type="button" class="secondary" :disabled="loading" @click="persistCurrentKey">Persist</button>
        <button type="button" class="danger" :disabled="loading" @click="deleteCurrentKey">Delete</button>
        <button type="button" class="secondary" :disabled="loading" @click="reloadDetail">Refresh</button>
      </div>
    </div>

    <div class="detail cli">
      <h3>CLI (Minimal)</h3>
      <p><strong>DB:</strong> {{ selectedDb }}</p>
      <label>
        Command
        <input v-model.trim="cliCommand" placeholder="例如: GET demo:key 或 SET demo:key 123" @keyup.enter="executeCli" />
      </label>
      <div class="detail-actions">
        <button type="button" :disabled="loading || !selectedConnection || !cliCommand" @click="executeCli">Execute</button>
      </div>
      <pre class="cli-output">{{ cliOutput }}</pre>
    </div>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'
import { connectionStorage } from '../connections/storage'

const connections = ref(connectionStorage.listConnections())
const selectedConnectionKey = ref('')
const databases = ref([0])
const selectedDb = ref(0)
const match = ref('*')
const cursor = ref('0')
const keys = ref([])
const loading = ref(false)
const message = ref('')
const statusOk = ref(true)
const selectedKey = ref('')
const detail = ref({ type: '', ttl: -1, value: '' })
const editableValue = ref('')
const ttlInput = ref('')
const cliCommand = ref('')
const cliOutput = ref('')

const editableTypes = ['string', 'hash', 'list', 'set', 'zset']
const canSaveCurrentType = computed(() => editableTypes.includes(detail.value.type))

const selectedConnection = computed(() => {
  const item = connections.value.find((line) => line.key === selectedConnectionKey.value)
  if (!item) {
    return null
  }

  return JSON.parse(JSON.stringify(item))
})

function toUiValueByType(type, rawValue) {
  if (type === 'string') {
    return String(rawValue ?? '')
  }

  if (type === 'hash') {
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
      return '{}'
    }
    return JSON.stringify(rawValue, null, 2)
  }

  if (type === 'list' || type === 'set' || type === 'zset') {
    if (!Array.isArray(rawValue)) {
      return '[]'
    }
    return JSON.stringify(rawValue, null, 2)
  }

  return String(rawValue ?? '')
}

function fromUiValueByType(type, text) {
  if (type === 'string') {
    return text
  }

  if (type === 'hash') {
    const parsed = JSON.parse(text || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('hash 编辑内容必须是 JSON 对象')
    }
    return parsed
  }

  if (type === 'list' || type === 'set' || type === 'zset') {
    const parsed = JSON.parse(text || '[]')
    if (!Array.isArray(parsed)) {
      throw new Error(`${type} 编辑内容必须是 JSON 数组`)
    }
    return parsed
  }

  return text
}

function applyDetailData(data = {}) {
  detail.value = {
    type: data.type || '',
    ttl: Number(data.ttl ?? -1),
    value: data.value ?? '',
  }
  editableValue.value = toUiValueByType(detail.value.type, detail.value.value)
  ttlInput.value = detail.value.ttl > 0 ? String(detail.value.ttl) : ''
}

function resetDetail() {
  selectedKey.value = ''
  detail.value = { type: '', ttl: -1, value: '' }
  editableValue.value = ''
  ttlInput.value = ''
}

function refreshConnections() {
  connections.value = connectionStorage.listConnections()
  if (!connections.value.find((line) => line.key === selectedConnectionKey.value)) {
    selectedConnectionKey.value = ''
    databases.value = [0]
    selectedDb.value = 0
    keys.value = []
    cursor.value = '0'
    resetDetail()
  }
}

async function loadDatabases() {
  if (!selectedConnection.value) {
    databases.value = [0]
    selectedDb.value = 0
    return
  }

  loading.value = true
  message.value = ''

  try {
    const response = await window.ardmApi?.redis?.listDatabases?.(selectedConnection.value)
    if (!response?.ok) {
      statusOk.value = false
      message.value = response?.message || '数据库列表获取失败'
      databases.value = [0]
      selectedDb.value = 0
      return
    }

    databases.value = Array.isArray(response.databases) && response.databases.length
      ? response.databases
      : [0]

    if (!databases.value.includes(selectedDb.value)) {
      selectedDb.value = databases.value[0]
    }

    statusOk.value = true
    message.value = response.message || '数据库列表获取成功'
  } catch (error) {
    statusOk.value = false
    message.value = error?.message || '数据库列表获取异常'
    databases.value = [0]
    selectedDb.value = 0
  } finally {
    loading.value = false
  }
}

async function runScan(nextCursor = '0') {
  if (!selectedConnection.value) {
    statusOk.value = false
    message.value = '请先选择连接'
    return
  }

  loading.value = true
  message.value = ''

  try {
    const response = await window.ardmApi?.redis?.scanKeys?.({
      connection: selectedConnection.value,
      db: selectedDb.value,
      match: match.value || '*',
      cursor: nextCursor,
      count: 100,
    })

    if (!response?.ok) {
      statusOk.value = false
      message.value = response?.message || 'Key 扫描失败'
      return
    }

    const data = response.data || {}
    cursor.value = String(data.cursor || '0')
    keys.value = Array.isArray(data.keys) ? data.keys : []
    statusOk.value = true
    message.value = response.message || 'Key 扫描成功'
    resetDetail()
  } catch (error) {
    statusOk.value = false
    message.value = error?.message || 'Key 扫描异常'
  } finally {
    loading.value = false
  }
}

function scanFromStart() {
  runScan('0')
}

function scanNext() {
  runScan(cursor.value)
}

async function loadKeyDetail(key) {
  if (!selectedConnection.value || !key) {
    return
  }

  loading.value = true
  try {
    const response = await window.ardmApi?.redis?.getKeyDetail?.({
      connection: selectedConnection.value,
      db: selectedDb.value,
      key,
    })

    if (!response?.ok) {
      statusOk.value = false
      message.value = response?.message || 'Key 详情获取失败'
      return
    }

    selectedKey.value = key
    applyDetailData(response?.data || {})
    statusOk.value = true
    message.value = response?.message || 'Key 详情获取成功'
  } catch (error) {
    statusOk.value = false
    message.value = error?.message || 'Key 详情获取异常'
  } finally {
    loading.value = false
  }
}

async function saveCurrentValue() {
  if (!selectedConnection.value || !selectedKey.value) {
    return
  }

  if (!canSaveCurrentType.value) {
    statusOk.value = false
    message.value = `当前 key 类型 ${detail.value.type} 暂不支持编辑`
    return
  }

  let parsedValue
  try {
    parsedValue = fromUiValueByType(detail.value.type, editableValue.value)
  } catch (error) {
    statusOk.value = false
    message.value = error?.message || 'Value 格式不正确'
    return
  }

  loading.value = true
  try {
    const response = await window.ardmApi?.redis?.saveKeyValue?.({
      connection: selectedConnection.value,
      db: selectedDb.value,
      key: selectedKey.value,
      type: detail.value.type,
      value: parsedValue,
    })

    if (!response?.ok) {
      statusOk.value = false
      message.value = response?.message || 'Key 保存失败'
      return
    }

    applyDetailData(response?.data || {})
    statusOk.value = true
    message.value = response?.message || 'Key 保存成功'
  } catch (error) {
    statusOk.value = false
    message.value = error?.message || 'Key 保存异常'
  } finally {
    loading.value = false
  }
}

async function applyTtl() {
  if (!selectedConnection.value || !selectedKey.value) {
    return
  }

  const ttl = Number(ttlInput.value)
  if (!Number.isFinite(ttl) || ttl <= 0) {
    statusOk.value = false
    message.value = 'TTL 必须是大于 0 的毫秒值'
    return
  }

  loading.value = true
  try {
    const response = await window.ardmApi?.redis?.setKeyTtl?.({
      connection: selectedConnection.value,
      db: selectedDb.value,
      key: selectedKey.value,
      ttl,
    })

    if (!response?.ok) {
      statusOk.value = false
      message.value = response?.message || 'TTL 设置失败'
      return
    }

    detail.value.ttl = Number(response?.data?.ttl ?? detail.value.ttl)
    ttlInput.value = detail.value.ttl > 0 ? String(detail.value.ttl) : ''
    statusOk.value = true
    message.value = response?.message || 'TTL 设置成功'
  } catch (error) {
    statusOk.value = false
    message.value = error?.message || 'TTL 设置异常'
  } finally {
    loading.value = false
  }
}

async function persistCurrentKey() {
  if (!selectedConnection.value || !selectedKey.value) {
    return
  }

  loading.value = true
  try {
    const response = await window.ardmApi?.redis?.persistKey?.({
      connection: selectedConnection.value,
      db: selectedDb.value,
      key: selectedKey.value,
    })

    if (!response?.ok) {
      statusOk.value = false
      message.value = response?.message || 'Persist 失败'
      return
    }

    detail.value.ttl = Number(response?.data?.ttl ?? -1)
    ttlInput.value = ''
    statusOk.value = true
    message.value = response?.message || '已移除过期时间'
  } catch (error) {
    statusOk.value = false
    message.value = error?.message || 'Persist 异常'
  } finally {
    loading.value = false
  }
}

async function deleteCurrentKey() {
  if (!selectedConnection.value || !selectedKey.value) {
    return
  }

  const key = selectedKey.value
  loading.value = true
  try {
    const response = await window.ardmApi?.redis?.deleteKey?.({
      connection: selectedConnection.value,
      db: selectedDb.value,
      key,
    })

    if (!response?.ok) {
      statusOk.value = false
      message.value = response?.message || '删除失败'
      return
    }

    statusOk.value = true
    message.value = response?.message || '删除成功'
    await runScan('0')
    resetDetail()
  } catch (error) {
    statusOk.value = false
    message.value = error?.message || '删除异常'
  } finally {
    loading.value = false
  }
}

async function executeCli() {
  if (!selectedConnection.value || !cliCommand.value) {
    return
  }

  loading.value = true
  try {
    const response = await window.ardmApi?.redis?.executeCommand?.({
      connection: selectedConnection.value,
      db: selectedDb.value,
      command: cliCommand.value,
    })

    if (!response?.ok) {
      statusOk.value = false
      message.value = response?.message || '命令执行失败'
      cliOutput.value = response?.raw || response?.message || ''
      return
    }

    statusOk.value = true
    message.value = response?.message || '命令执行成功'
    cliOutput.value = JSON.stringify(response?.data?.result, null, 2)

    if (selectedKey.value) {
      await loadKeyDetail(selectedKey.value)
    }
  } catch (error) {
    statusOk.value = false
    message.value = error?.message || '命令执行异常'
    cliOutput.value = error?.message || ''
  } finally {
    loading.value = false
  }
}

function reloadDetail() {
  if (!selectedKey.value) {
    return
  }
  loadKeyDetail(selectedKey.value)
}

async function onConnectionChange() {
  keys.value = []
  cursor.value = '0'
  resetDetail()
  await loadDatabases()
}
</script>

<style scoped>
.keys {
  margin-top: 18px;
  max-width: 900px;
}

.toolbar {
  display: grid;
  grid-template-columns: repeat(3, minmax(160px, 1fr));
  gap: 10px;
  align-items: end;
}

label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}

select,
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
}

button.secondary {
  border-color: #6b7280;
  background: #6b7280;
}

button.danger {
  border-color: #dc2626;
  background: #dc2626;
}

button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.meta {
  display: flex;
  gap: 12px;
  margin: 10px 0;
  color: #6b7280;
  font-size: 12px;
}

.key-list {
  list-style: none;
  padding: 0;
  margin: 0;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  max-height: 280px;
  overflow: auto;
}

.key-list li {
  padding: 8px 12px;
  border-bottom: 1px solid #f3f4f6;
  cursor: pointer;
}

.key-list li.active {
  background: #eff6ff;
}

.key-list li:last-child {
  border-bottom: none;
}

.detail {
  margin-top: 12px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 12px;
}

.detail h3 {
  margin: 0 0 8px;
}

.ttl-row {
  margin-top: 8px;
  max-width: 260px;
}

.detail-actions {
  margin-top: 8px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

textarea {
  width: 100%;
  min-height: 120px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  padding: 8px;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.cli {
  margin-top: 12px;
}

.cli-output {
  margin-top: 8px;
  background: #111827;
  color: #e5e7eb;
  border-radius: 6px;
  padding: 10px;
  min-height: 80px;
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.success {
  color: #059669;
  margin: 8px 0;
}

.error {
  color: #dc2626;
  margin: 8px 0;
}
</style>

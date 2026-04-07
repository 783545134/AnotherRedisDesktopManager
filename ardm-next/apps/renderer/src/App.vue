<template>
  <main class="app">
    <h1>ARDM Next</h1>
    <p>Electron: {{ electronVersion }}</p>
    <p>Platform: {{ platform }}</p>
    <ConnectionManager />
    <KeyBrowser />
  </main>
</template>

<script setup>
import ConnectionManager from './modules/connections/ConnectionManager.vue'
import KeyBrowser from './modules/keys/KeyBrowser.vue'

const electronVersion = window.ardmApi?.app?.getVersion?.() || 'unknown'
const platform = window.ardmApi?.app?.getPlatform?.() || 'unknown'
</script>

<style scoped>
.app {
  font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  padding: 24px;
  color: #1f2937;
}
</style>

<script setup lang="ts">
import { onMounted } from 'vue';
import LoginView from './components/LoginView.vue';
import Workbench from './components/Workbench.vue';
import { useAuthStore } from './stores/auth';

const auth = useAuthStore();
onMounted(() => void auth.restore());
</script>

<template>
  <LoginView v-if="!auth.user" />
  <Workbench v-else />
</template>

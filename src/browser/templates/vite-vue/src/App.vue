<template>
  <div class="container">
    <h1>{{ message }}</h1>
    <p>Edit src/App.vue to get started.</p>
  </div>
</template>

<script>
export default {
  name: 'App',
  data() {
    return {
      message: 'Hello Vue!'
    }
  }
}
</script>

<style scoped>
.container {
  max-width: 800px;
  margin: 0 auto;
  padding: 2rem;
  text-align: center;
}

h1 {
  color: #42b983;
  font-size: 3em;
}

p {
  color: #2c3e50;
}
</style>

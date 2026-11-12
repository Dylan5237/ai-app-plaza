import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import './styles/buttons.css'
import './styles/design-tokens.css'
import './styles/redesign.css'
import App from './App.vue'

createApp(App).use(ElementPlus).mount('#app')

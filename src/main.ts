import './style.css';
import { Arena } from './ui';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('未找到应用挂载节点。');
new Arena(root);

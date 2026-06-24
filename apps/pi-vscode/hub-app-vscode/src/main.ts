import { mount } from "svelte";
// Registers all <vscode-*> custom elements (buttons, tabs, tree, badge, …).
import "@vscode-elements/elements";
import App from "./App.svelte";
import "./lib/theme.css";

const app = mount(App, { target: document.getElementById("app")! });
export default app;

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Startup Logo Extension — 2-Column Layout
 *
 * Replaces pi's built-in header with a full startup dashboard:
 *   Left  — ASCII art logo (randomly chosen from a collection)
 *   Right — skills, prompts, extensions, model, cwd, branch
 *
 * ── Commands ──
 *   /builtin-header   — restore default pi header
 */

// ── ASCII logo collection (randomly chosen at session start) ─────
const LOGOS: string[] = [
  // Logo 1 — dragon/pi symbol
  `⢀⣶⣶⣾⣿⣿⣿⣿⣿⣿⠀⠀⠀⣀
⠀⠀⠀⠀⠀⡀⠀⢠⣿⠏⠀⠀⠀⣿⠆⠀⣿⣆
⠀⠀⠀⠀⠈⣿⣆⠛⠁⠀⠀⠀⢸⣿⠀⠀⠹⣿⡄⠀⠠⣿⣿⣿⣿⣷⡄⠀⠀⣤⣤⣤⣤⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣤⣦⣶⣶⣶
⠀⠀⠀⠀⠀⣿⣿⠀⠀⠀⠀⠀⣿⡟⠀⠀⠀⠹⣿⣆⠀⠀⣶⣶⣿⡿⠀⢀⣀⡉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠁
⠀⠀⠀⠀⠀⣿⣿⠀⠀⠀⠀⣾⣿⠀⠀⠀⠀⠀⠈⠿⠟⠀⣼⣿⠁⣠⣿⣿⣿⣿⣿⣄
⠀⠀⠀⠀⠀⠿⠇⠀⠀⠀⠀⠛⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠁⣼⣿⣿⣿⣿⣿⣿⣿⣷⡀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡄
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣠⣀⠀⡾⠋⠉⠉⣻⣋⣀⣀⣀⣹⡿⠿⢿⣄
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣀⡾⠀⣠⣴⣿⣿⣿⣿⣿⣟⣿⣿⣿⣿⣿⣿⣿⣶⣘⡄
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣰⠁⣠⣶⣿⣿⣿⣿⣿⣿⣿⡿⣿⣯⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡉⢷
⠀⠀⠀⠀⠀⣶⣿⣿⣿⣿⣿⠟⢛⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣄⣿⣦⡀
⠀⠀⠀⠀⢸⣿⣿⣿⣿⣿⢀⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠛⠿⢿⣿⣿⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⢿⣄
⠀⠀⠀⠀⢸⣿⣿⣿⠟⣽⣿⣿⣫⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠃⣾⣤⣾⣶⠀⠈⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣯⢿⣄
⠀⠀⠀⠀⠸⣿⣿⣿⣾⣿⣿⢱⠁⠀⢿⣿⣿⣿⣷⠈⠛⡿⠉⣀⣾⠿⠋⠁⠀⠀⠀⠀⠈⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⢽⡄
⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⠁⠀⠀⠀⠀⠙⣿⡿⠛⠁⠀⠀⣼⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
⠀⠀⠀⠀⠀⠹⣿⣿⣿⡟⠀⠀⠀⠴⠒⠛⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣺
⠀⠀⠀⠀⠀⠀⣿⣿⣿⠁⠀⠀⠀⠀⣀⣤⣤⠀⠀⠠⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠛⠉⢿⣿⣿⣿⣿⣿⣿⣿⣿⡟⠉⠙⡄
⠀⠀⠀⠀⠀⠀⣯⣿⣿⣀⣀⣿⡿⠛⠁⠀⠀⠀⠀⢀⠟⠉⠉⠉⢿⠛⡟⢿⠀⠀⠀⠀⠀⠀⠀⢸⣿⣿⣿⣿⣿⣿⠋⠉⠀⠘⠀⣿
⠀⠀⠀⠀⠀⠀⢹⣮⣿⢸⠟⠁⠀⠀⠀⠀⠀⠀⢀⠟⡀⠀⠀⠀⠀⠉⠀⠀⣧⠀⠀⠀⠀⠀⢀⣾⣿⣿⣿⣿⣿⣏⠀⠀⠀⠗⢀⣿⡷⣤
⠀⠀⠀⠀⠀⠀⣿⣿⣿⡆⠀⠀⠀⠀⠀⠀⠀⢠⣿⠶⠇⠀⠀⠀⠀⢀⣀⠀⢸⠀⠀⠀⣠⠶⠹⣿⠿⣿⠻⣿⣿⠿⠛⠶⠶⠚⠛⣿⣿⣾
⠀⠀⠀⠀⠀⠀⣟⣿⣿⣧⠀⠀⠀⠀⠀⠀⠀⠀⠈⣧⠀⠀⠀⣶⠛⠉⠉⠉⣿⡶⠛⠉⠀⠀⣠⡇⠀⣿⣿⣦⠻⣄⠀⠀⠀⠀⠀⠀⢻⣿
⠀⠀⠀⠀⠀⠀⣷⣿⣿⣿⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢷⡀⣿⠀⣀⣤⣾⢻⠃⠀⠀⠀⠀⣠⣿⡇⠙⣿⣿⣿⣷⢻⡄⠀⠀⠀⠀⠀⠀⠹
⠀⠀⠀⠀⠀⠀⢿⣻⣟⣿⣿⣄⠀⠀⠀⠀⠀⠀⠀⠀⣀⣽⠿⠿⣟⡿⢧⡏⠀⠀⠀⣀⣿⣿⣿⡇⢠⣿⣿⣿⣿⣇⣿
⠀⠀⠀⠀⠀⠀⠀⢿⣽⡛⣿⡿⣿⣶⣤⣤⣴⣶⠟⢹⡅⠀⠀⠀⠀⠀⣽⠀⣠⣴⣿⣿⠿⠛⣛⣿⠈⣿⣿⣿⣿⣿⢼⡆
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣼⣻⣿⣿⣿⣿⣿⣿⣤⠀⣿⣿⣶⣶⣷⣾⣿⣿⣿⢟⣤⠶⢛⣉⣤⣾⡘⣿⣿⣿⣿⣿⡅⣷
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠉⠉⠉⠉⠉⠉⠉⠉⠀⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠀⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉`,

  // Logo 2 — pi text logo
  `
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⡶⡆⢶⠻⡄⠀⠀⠀⣸⠛⣇⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣀
⠀⠀⠀⠀⠀⡀⠀⠀⠀⣤⠶⠾⠃⠛⢻⣷⡽⠀⣿⣉⡉⣀⣀⣠⡇⠀⠐⣍⣉⣭⠉⡇⠀⠀⣯⣭⣭⠉⣷⠀⠀⡗⢸⠀⠀⢀⡆
⠀⠀⠀⠀⠀⢿⠀⠀⠀⣿⢸⠛⢻⠀⣯⡷⡄⠀⠀⡾⠐⠋⡟⡶⡀⠀⠀⠀⠀⠙⠛⠀⠀⠀⠀⠀⠘⠶⠃⠀⠀⣇⣿⠀⠀⡿
⠀⠀⠀⠀⠀⠀⢿⠀⠀⣿⣘⣻⠀⣿⠀⣾⠀⠀⠀⣼⢁⢞⠞⣼⠀⠀⠀⡟⠶⠶⠛⡄⠀⠀⡶⢦⣤⢶⡀⠀⠀⣴⣦⠀⣼⠁
⠀⠀⠀⠀⠀⠀⠀⣷⢀⣇⡏⠀⠺⣥⠿⣤⠿⠀⠻⣤⣫⢋⡾⣌⡷⠀⠀⠈⠉⣛⣿⣥⣄⠀⠙⠶⠶⠞⠁⠀⠀⠳⠟⠰⠇
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠋⠀⠀⠀⠀⢀⣴⣿⣿⣿⣿⣿⣿⡄
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣀⣀⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣄
⠀⠀⠀⠀⠀⠀⠀⢀⣿⣿⣿⣿⣿⣿⣷⣦⣄⣴⠚⢛⣶⣯⣤⣤⣿⣷⣶⣶⣿⣭⣄⣙⣿⣿⣿⣿⡄
⠀⠀⠀⠀⠀⠀⠀⣾⣿⣿⣿⣿⣿⣿⣋⣤⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣟⢿⣿⣿⣿⣶⣈⣿⣿⡀
⠀⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣩⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣻⣿⣛⣣⣿⣿⣿⣿⣿⣿⣄⠻⡀
⠀⠀⠀⠀⠀⠀⢰⣿⡿⣩⣿⣿⣿⣿⣿⣿⣿⣏⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣯⢷⡇
⠀⠀⠀⠀⠀⠀⣸⡿⣶⣿⣿⣿⣿⣿⣿⡿⢁⠀⠹⣿⣿⣿⡟⣿⣿⣿⠿⠋⢉⠀⠀⠹⣿⣿⣿⣿⣿⣿⣝⣆
⠀⠀⠀⠀⠀⠀⣿⣾⣿⣿⣿⣿⣿⣿⣿⣶⣶⣬⣁⠙⢿⣿⡿⠀⠛⣶⠀⢀⣾⣷⠀⠀⣿⠛⠿⣿⣿⣿⣿⣯⣷⡀
⠀⠀⠀⠀⠀⠀⢸⣿⣿⣿⣿⡏⠀⠀⣰⢿⠀⠀⣬⠀⠀⠀⠀⠀⠀⢻⣿⣿⣅⣿⠀⠀⠃⠀⠀⢻⣿⣿⣿⣿⣿⣟⣦
⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⣇⠀⠀⣿⠀⢹⠛⢸⠀⠀⠀⠀⠀⠀⠀⢯⣠⣤⡾⠀⠀⠀⠀⠀⢸⣿⣿⣿⣿⣿⣿⣷⢿
⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⠛⠀⠀⢹⡀⠀⠁⡼⠀⠀⠀⠈⠀⠀⠀⠀⢠⠀⠀⠀⠀⠀⠀⠀⣸⣿⣿⣿⣿⣿⣿⣿⡮⣇
⠀⠀⠀⠀⠀⢀⣿⣿⣿⣿⣿⡀⠀⠀⠀⠙⠉⠉⣄⠀⠀⣀⡾⠛⠶⢶⣻⣷⠀⠀⠀⠀⠀⠀⠰⢿⣿⣿⣿⣿⣿⣿⣿⣟⡟
⠀⠀⠀⠀⠀⣿⣾⣿⣿⣿⣿⣧⠀⠀⠀⠀⠀⠀⠀⢿⢯⠇⠀⠀⠀⠀⠀⢿⠀⠀⠀⠀⠀⠀⠀⣼⣿⣿⣿⣿⣿⣿⡏⢉⠳
⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣦⠀⠀⠀⠀⠀⠀⠀⣷⠀⣀⣤⡶⠶⣤⣺⠀⠀⠀⠀⠀⣠⣾⣿⣿⣿⣿⣿⡟⠠⠀⣄⠀⣇⣀
⠀⠀⠀⠀⠀⢹⣾⣿⣿⣿⣿⣿⣦⡀⠀⠀⠀⠀⠀⠀⠸⡾⠁⠀⠀⢀⣀⣿⣤⠶⠚⢻⣯⠀⣿⣷⣾⣯⣟⣻⢷⣤⣀⣤⣿⣿⣿⣿⡷⣦
⠀⠀⠀⠀⣠⠟⣿⣿⣿⣿⣿⣿⣿⣿⣿⠶⢤⣤⡤⠴⠶⣿⢿⣯⣿⢟⡷⠁⠀⣀⣤⣿⣿⣆⠘⣿⣿⣿⣿⣿⣿⣷⣟⣆⠀⠙⣿⣿⣿⣿
⠀⠀⠀⠀⣿⠀⠀⡄⠈⣿⠿⣿⡿⣻⣇⠀⢸⣿⣤⡄⠀⠀⠙⢯⣩⠋⢀⣤⣶⣿⣿⣿⣿⣿⣀⣿⣿⣿⣿⣿⣿⣿⣿⢹⡀⠀⠀⠻⣿⣿
⠀⠀⠀⢀⣼⣮⣀⣠⠶⠁⣴⣫⣿⣿⡇⠀⣿⣿⣿⣿⣿⣿⣤⣾⣿⣻⣭⣤⡴⠶⠶⠶⠶⢦⣽⣇⡙⣿⣿⣿⣿⣿⣿⣧⣧⠀⠀⠀⠈⣿
⠀⠀⣴⣫⣿⣿⠃⠀⢀⡾⣿⣿⣿⣿⣿⡀⣿⠋⣀⣤⠾⣛⣫⣭⣶⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⡀⣧⠘⣿⣿⣿⣿⣿⣿⢻
⢀⣿⣽⣿⣿⡏⠀⠀⣿⣿⣿⣿⣿⣿⢀⠟⣿⣩⣴⣿⣿⣿⠿⢿⣿⣟⣭⡭⠶⠶⠖⠚⠛⠛⠒⢿⡶⢿⣹⣿⣿⣿⣿⣿⡍⣇
⣿⣾⣿⣿⣿⠀⠀⠀⢹⡼⣿⣿⣿⣿⢰⢀⣿⣿⣻⡽⠞⠛⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣿⣿⠀⣿⣿⣿⣿⣿⣿⣗⡿
  `,

  // Logo 3 — minimalist mountain range
  `
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡶⠶⣤⣤⣤⠀⠀⠀⠀⠀⠀⠀⠀⣴⠟⠛⠛⠻⣦
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣧⣤⣤⣤⣼⠀⠀⠀⠀⠀⠀⠀⠀⢿⡾⠛⠻⡄⠀⣷
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠐⡶⠛⠛⠛⠛⠛⢶⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⡟⠀⡿
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠐⠷⠶⢶⡶⠀⠀⣾⠀⠀⠀⠀⠀⠀⠀⠀⠀⢹⠀⣴⠟
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⠟⠀⠀⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠸⠶⠿
⠀⠀⠀⠀⠀⠀⠀⠀⠀⣶⠛⢀⣤⠿⣆⠈⠻⠶⣦⠀⠀⠀⠀⠀⠀⠀⢸⡉⣻
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠟⠋⠀⠀⠘⠷⣦⡴⠟⠀⠀⠀⠀⠀⠀⠀⠀⠉⠉
⠀⠀⠀⠀⠀⠀⠀⢀⣾⣿⣿⣶⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣠⣤⣄
⠀⠀⠀⠀⠀⠀⠀⣾⣿⣿⣿⣿⣿⣿⣦⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣴⣿⣿⣿⣿⣿⣿⣿
⠀⠀⠀⠀⠀⠀⢠⣿⣿⣿⣿⣿⣿⠟⠛⣿⡞⠉⢉⣳⣞⠁⠈⢳⡶⠛⢿⣿⣿⣿⣿⣿⣿⣿⡇
⠀⠀⠀⠀⠀⠀⣾⣿⣿⡟⠉⣹⣤⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⢿⣶⣦⣿⠋⠛⢿⣿⣿⣿⣿
⠀⠀⠀⠀⠀⠀⡿⠛⣻⣶⣿⣿⣿⠟⣿⣿⣿⣿⣿⣿⣿⣎⣿⣝⣵⣿⣿⣿⣿⣷⣀⣿⣿⣿⣿
⠀⠀⠀⠀⠀⣀⣧⣿⣿⣿⣿⣫⠴⠶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⠀⢿⣿
⠀⠀⠀⠀⡟⣴⣿⣿⣿⣿⣶⣤⣄⡀⢹⣿⣿⣿⣿⣿⣿⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣾⣿⣧
⠀⠀⠀⢠⢻⣿⣿⣿⡏⠀⢀⡏⠀⠙⣧⢿⣿⣿⣿⣿⣿⣾⠛⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⠈⣿⣦
⠀⠀⠀⠸⣿⣿⣿⠁⣇⠀⣾⠳⣄⣀⣼⠀⠉⠈⠉⠉⠀⣿⡀⠀⢀⣿⠙⢻⣿⣿⣿⣿⣿⣿⣶⣿⣾⣧
⠀⠀⠀⠀⣿⣿⡏⠀⠀⠀⣿⠀⠀⠀⣸⠀⠀⠀⠀⠀⠀⣿⣿⢿⣿⣿⠀⠟⣿⣿⣿⣿⣿⣿⣷⣿⣿⣯⣷
⠀⠀⢀⣾⣿⣿⠅⠀⠀⠀⠈⢦⣀⡴⠃⠀⠀⠀⠀⠀⠀⠙⣦⣤⠾⠁⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣯⣿
⠀⣠⢿⣿⣿⡏⠀⠀⠀⠀⠀⠙⠛⠀⢀⣤⠶⠛⠷⣄⠀⠀⠛⠛⠃⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡆
⠀⡿⣿⣿⣿⣧⠀⠀⠀⠀⠀⠀⠀⠹⡻⠏⠀⠀⠀⢿⡿⣦⠀⠀⠀⠀⠀⣼⣿⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣯⡇
⠀⣷⣿⣿⣿⣿⣦⠀⠀⠀⠀⠀⠀⠀⢿⡴⠋⣽⠉⠳⣠⠃⠀⠀⠀⠀⠀⠀⠀⢀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣻⠃
⠀⢻⡽⣿⣿⣿⣿⣿⣦⣄⣀⠀⠀⠀⠀⢷⡀⠈⠀⣠⠋⠀⠀⠀⠀⠀⢀⣠⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣫⡟
⠀⠀⠙⣿⣿⣿⣿⣿⣿⡇⠀⡾⠉⠉⠻⡟⣿⡿⣿⠿⣭⠟⠉⠉⠉⢹⠁⠀⣿⣿⣿⣿⣿⣿⣿⡟⠛⠻⠋
⠀⠀⢸⢁⠛⠁⣈⡿⣿⠋⣼⣿⡀⠀⠀⠈⣦⢉⡼⠋⠀⠀⠀⠀⣀⡿⠀⢻⣿⣝⣿⣿⡿⠀⠉⠀⠋⠀⡇
⠀⢀⣾⣦⣘⣠⣟⣿⣿⠀⣿⣿⣷⣤⠀⢀⡴⠁⠀⠀⠀⠀⣀⣾⣿⡇⢤⣿⣿⣿⣯⣷⣧⠀⠀⠘⣀⣼⣄
⠴⠿⠿⠿⠋⠿⠿⠿⠿⠰⠿⠿⠿⠿⠿⠿⠶⠿⠶⠾⠿⠿⠿⠿⠿⠇⠀⠿⠿⠿⠿⠯⠷⠈⠉⠉⠿⠿⠮⠷
  `,

  // Logo 4 — simple arrow / chevron
  `
⠀⠀⠀⠀⠀⠀⠀⣤⣴⣄⠀⣶⠛⣦⠀⠀⠀⠀⣟⠋⣿⠀⣠⠶⣆⠀⠀⠀⠀⢸⠛⣇⣀⣀⠀⠀⠀⡀
⠀⠀⠀⠀⠀⣤⣤⠇⠀⠿⠶⠾⣷⣀⣷⢰⠶⠶⠟⠀⠛⠲⠛⣧⠈⣦⠀⡟⠛⠉⠀⣁⣀⣽⠀⢸⠉⠘⡄⢀⣀⣀⣀⣀
⠀⠀⠀⠀⠸⣄⣀⣄⠀⢠⣤⣤⠿⠉⠀⠸⣤⣤⣤⠀⢴⠶⠶⠟⠋⠁⠀⣋⣩⣽⡆⠿⠶⠶⡄⢨⠂⠀⡇⢸⡀⠀⠀⣸
⠀⠀⠀⠀⠀⠀⣀⣿⠀⠘⠶⠶⣄⠀⠀⠀⢀⡴⠟⠀⠘⠷⠶⣤⠀⠀⠀⣿⣤⣤⣤⠀⣶⠶⠇⢸⠀⠀⡇⠀⠉⠉⠉
⠀⠀⠀⠀⠀⣼⠁⠀⠀⠀⢀⡀⠈⣷⠀⢀⠏⠀⢀⠀⠀⣠⣀⠀⣷⠀⠀⢀⣤⠀⢻⠀⢿⠀⠀⢸⠀⠀⡇⣤⣀⣀⣀⣀
⠀⠀⠀⠀⠀⣿⠀⠘⠃⠀⣿⢹⠀⣼⠀⠘⡆⠀⠈⠀⢀⡟⢹⠀⣿⠀⠀⢿⡀⠻⣤⣛⠉⠀⠀⢸⠀⢸⠀⣧⡀⠀⠀⢸
⠀⠀⠀⠀⠀⠈⢷⣤⣤⠾⠁⠘⠻⠛⠀⠀⠙⠶⢤⠶⠋⠀⠀⠈⠀⠀⠀⠀⠙⠶⣤⣼⠃⠀⠀⠈⣛⣋⠀⠀⠈⠉⠉⠁
⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⣶⣶⣦⣤⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⣴⣿⣿⣿⣿⣿⣿
⠀⠀⠀⠀⠀⠀⠀⠀⢰⣿⣿⣿⣿⣿⣿⣿⣷⡴⠶⢦⣠⠛⠉⠈⠙⣦⠚⠉⠛⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣇
⠀⠀⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⠿⠿⢿⣃⣤⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣾⣯⣄⡀⠈⣿⣿⣿⣿⣿⣿
⠀⠀⠀⠀⠀⠀⠀⢀⣿⣿⣿⣿⢁⣴⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣄⡀⠻⣿⣿
⠀⠀⠀⠀⠀⠀⠀⢸⣿⠏⢀⣾⣿⣿⣻⣾⣯⣿⣿⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣄⣿⣿
⠀⠀⠀⠀⠀⠀⠀⢸⣿⣶⣿⣿⣿⣿⣿⣿⣿⣿⠖⠚⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⠙⣆
⠀⠀⠀⠀⠀⠀⠀⣾⣼⣿⣿⣿⣿⣿⣿⠋⠀⠀⠀⠀⠙⣿⣿⣿⣿⣿⣿⣿⣿⡟⠻⣿⣿⣿⣿⣿⣿⣿⣿⣷⣿
⠀⠀⠀⠀⠀⠀⠀⣹⣿⣿⣿⣿⣿⡿⠀⠀⠀⠀⠀⠀⠀⠈⠿⠙⠿⠿⠛⠛⠛⠃⠀⠀⠻⣿⣿⣿⣿⣿⣿⣿⣧
⠀⠀⠀⠀⠀⠀⢀⣿⣿⣿⣿⣿⡟⣀⣭⡭⣭⣿⣷⣦⡀⠀⠀⠀⠀⠀⠀⣠⣖⣋⣉⣁⣀⣀⠈⠙⢿⣿⣿⣿⣿⣆
⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⡿⠀⢠⠚⠋⠉⠀⠀⠉⠉⠀⠀⠀⠀⠀⠈⠉⠉⠉⠉⠉⠛⠶⠀⠀⢸⣿⣿⣿⣿⣿⣧
⠀⠀⠀⠀⢀⣿⣿⣿⣿⣿⣿⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣯⣷
⠀⠀⠀⠀⡿⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀⠀⠀⠳⣤⣤⣤⡴⠶⠛⠷⣤⣤⣠⣤⠶⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣺⡄
⠀⠀⠀⢸⡗⣿⣿⣿⣿⣿⣧⠀⠀⠀⠀⠀⠀⠀⣇⠙⠋⠀⠀⠀⠀⠀⠙⠋⢨⠂⠀⠀⠀⠀⠀⣾⣿⣿⣿⣿⣿⣿⣿⣺⠇
⠀⠀⠀⠘⣷⣿⣿⣿⣿⣿⣿⣦⠀⠀⠀⠀⠀⠀⣿⠀⠀⠀⣀⣀⣀⣀⠀⠀⢸⠀⠀⠀⠀⠀⠀⠀⣾⣿⣿⣿⣿⣿⣯⡿
⠀⠀⠀⢀⠟⠋⣿⣿⣿⣿⣿⣿⣿⣶⣄⣀⠀⠀⠘⣤⠛⠉⠀⠀⠀⠀⠙⢦⣿⠀⠀⠀⠀⣀⣴⣿⣿⣿⣿⣿⣿⠉⢀⠻⡀
⠀⠀⠀⢸⠸⠇⠀⠁⢀⠀⠻⣿⡿⣇⠀⡁⠈⠉⠉⠉⠿⣛⣿⢿⣿⣟⠿⠉⠉⠉⠉⣿⠁⠀⣿⡝⣿⣿⡟⢀⠀⠀⠉⠀⡇
⠀⠀⠀⣀⣦⠀⢇⠀⠉⠀⣼⣿⣾⣧⠀⣿⣶⣿⣿⣷⠀⠈⢿⡛⡵⠁⠀⡞⣿⣿⣿⣿⡀⢰⣿⣿⢿⠀⣦⠈⠀⠘⢁⣾⣿⣤
⠀⢀⡾⣽⣿⣿⣶⠶⠖⠋⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⠀⠀⠉⠀⠀⣰⢻⣿⣿⣿⣿⣿⣿⣿⣿⣺⠀⠀⠉⠉⠉⢿⣿⣿⣷⡻⣦
⢀⣿⣿⣿⣿⣿⠃⠀⠀⠀⠀⢹⣿⣿⣿⣿⣿⣿⣿⣿⣿⣶⣷⣶⣿⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣮⣿⡀
  `,
];

// ── Scan startup resources ───────────────────────────────────────
const PI_DIR = join(homedir(), ".pi");

function readDir(dir: string): string[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => {
        const name = e.name.endsWith(".ts") ? e.name.slice(0, -3) : e.name;
        return name.endsWith(".md") ? name.slice(0, -3) : name;
      });
  } catch {
    return [];
  }
}

const skills   = readDir(join(PI_DIR, "skills"));
const extNames = readDir(join(PI_DIR, "agent", "extensions"));
const prompts  = readDir(join(PI_DIR, "prompts"));

function formatCwd(cwd: string): string {
  const home = homedir();
  if (cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

// ── Build right-column content ──────────────────────────────────
function buildSection(theme: any, symbol: string, label: string, names: string[],
  rightWidth: number, maxLines: number, labelColor: string = "success"
): string[] {
  const lines: string[] = [];
  const hdr = theme.fg(labelColor as any, `${symbol} ${label} (${names.length}):`);
  lines.push(hdr);
  const flat = names.join(", ");
  const wrapped = wrapTextWithAnsi(theme.fg("dim", flat), rightWidth);
  for (const w of wrapped) {
    if (lines.length >= maxLines) break;
    lines.push(w);
  }
  return lines;
}

function pickRandomLogo(seed: number): string {
  return LOGOS[seed % LOGOS.length];
}

function buildDetails(theme: any, pi: ExtensionAPI, ctx: any,
  branch: string | undefined, rightWidth: number, logo: string
): string[] {
  const logoLines = logo.split("\n");
  const maxLines = logoLines.length;
  const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
  const cwd = formatCwd(ctx.cwd);
  const branchStr = branch ? ` (${branch})` : "";
  const cmdCount = pi.getCommands().length;
  const activeTools = pi.getActiveTools();

  const fixedLines = 9;
  const contentBudget = Math.max(3, maxLines - fixedLines);

  const skillAlloc = Math.max(1, Math.floor(contentBudget * 0.40));
  const toolAlloc  = Math.max(1, Math.floor(contentBudget * 0.25));
  const extAlloc   = Math.max(1, contentBudget - skillAlloc - toolAlloc);

  const skillSection = buildSection(theme, "◆", "skills", skills, rightWidth, skillAlloc);
  const toolSection  = buildSection(theme, "▶", "tools", activeTools, rightWidth, toolAlloc, "warning");
  const extSection   = buildSection(theme, "◆", "extensions", extNames, rightWidth, extAlloc, "accent");

  const lines: string[] = [];

  lines.push(theme.fg("accent", theme.bold("pi")) + theme.fg("dim", ` v${VERSION}`));

  if (lines.length < maxLines) lines.push("");

  for (const l of skillSection) {
    if (lines.length >= maxLines) break;
    lines.push(l);
  }

  if (lines.length < maxLines) lines.push("");

  for (const l of toolSection) {
    if (lines.length >= maxLines) break;
    lines.push(l);
  }

  if (lines.length < maxLines) lines.push("");

  for (const l of extSection) {
    if (lines.length >= maxLines) break;
    lines.push(l);
  }

  const footer: string[] = [
    "",
    theme.fg("muted", `model:  ${model}`),
    theme.fg("muted", `cwd:    ${cwd}${branchStr}`),
    theme.fg("dim", `${cmdCount} cmd  ·  Ctrl+P  ·  /builtin-header`),
  ];
  for (const f of footer) {
    if (lines.length >= maxLines) break;
    lines.push(f);
  }

  return lines;
}

export default function (pi: ExtensionAPI) {
  let branch: string | undefined;

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    try {
      const result = await pi.exec("git", ["branch", "--show-current"], { cwd: ctx.cwd });
      branch = result.stdout.trim() || undefined;
    } catch {
      branch = undefined;
    }

    // Pick a random logo using the timestamp as seed so each session gets a fresh one
    const chosenLogo = pickRandomLogo(Date.now());
    const logoLines = chosenLogo.split("\n");
    const logoWidth = Math.max(...logoLines.map((l) => visibleWidth(l)));

    ctx.ui.setHeader((_tui, theme) => ({
      invalidate() {},
      render(width: number): string[] {
        const MIN_RIGHT = 25;
        const leftWidth = Math.min(logoWidth, Math.max(width - MIN_RIGHT - 3, 10));
        const rightWidth = Math.max(MIN_RIGHT, width - leftWidth - 3);
        const details = buildDetails(theme, pi, ctx, branch, rightWidth, chosenLogo);
        const result: string[] = [];
        const maxLines = Math.max(logoLines.length, details.length);

        for (let i = 0; i < maxLines; i++) {
          const left = i < logoLines.length
            ? truncateToWidth(logoLines[i] ?? "", leftWidth)
            : "";
          const right = i < details.length
            ? truncateToWidth(details[i] ?? "", rightWidth)
            : "";
          if (left) {
            const pad = " ".repeat(Math.max(0, leftWidth + 3 - visibleWidth(left)));
            result.push(truncateToWidth(left + pad + right, width));
          } else {
            const pad = " ".repeat(leftWidth + 3);
            result.push(truncateToWidth(pad + right, width));
          }
        }

        return result;
      },
    }));
  });

  pi.registerCommand("builtin-header", {
    description: "Restore built-in header with keybinding hints",
    handler: async (_args, ctx) => {
      ctx.ui.setHeader(undefined);
      ctx.ui.notify("Built-in header restored", "info");
    },
  });
}

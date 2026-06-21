/**
 * pi-shazam core/git-utils — 共享 git 工具函数。
 *
 * 解决 issue #350：在非 git 仓库目录下，扩展会输出 git 的 stderr 错误
 * （"fatal: not a git repository"），污染用户终端/UI。
 *
 * 本模块提供：
 * - isGitRepo: 一次性检测目录是否为 git 仓库，结果缓存，避免反复 spawn git 进程
 * - isProjectDir: 检测目录是否为项目目录（有标记文件或 git 仓库），用于快速短路
 * - safeGitExec: 安全执行 git 命令，自动抑制 stderr，非 git 仓库直接返回 null
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ── 项目标记文件列表 ────────────────────────────────────────────────────────

/**
 * 判断目录是否为项目根目录的标记文件。
 * 任一文件存在即视为项目目录。
 */
const PROJECT_MARKERS: readonly string[] = [
	"package.json",
	"tsconfig.json",
	"Cargo.toml",
	"go.mod",
	"pyproject.toml",
	"setup.py",
	"requirements.txt",
	"Makefile",
	"pom.xml",
	"build.gradle",
	"pubspec.yaml", // Dart/Flutter
	".git",
];

// ── Git 可用性缓存 ──────────────────────────────────────────────────────────

/**
 * 缓存已检测的 git 仓库状态。key = 目录绝对路径，value = 是否为 git 仓库。
 * 进程生命周期内缓存，避免对同一目录反复 spawn git 进程。
 */
const gitRepoCache = new Map<string, boolean>();

// ── 核心函数 ────────────────────────────────────────────────────────────────

/**
 * 检测目录是否为 git 仓库。
 * 结果缓存到进程生命周期，同一目录只检测一次。
 *
 * 使用 `git rev-parse --is-inside-work-tree` 检测，
 * stderr 被完全抑制（stdio: ["ignore", "pipe", "ignore"]），
 * 避免 "fatal: not a git repository" 泄漏到用户终端。
 */
export function isGitRepo(projectRoot: string): boolean {
	const cached = gitRepoCache.get(projectRoot);
	if (cached !== undefined) return cached;

	let result = false;
	try {
		const output = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
			cwd: projectRoot,
			encoding: "utf-8",
			timeout: 3000,
			// 抑制 stderr，防止 "fatal: not a git repository" 泄漏到用户终端
			stdio: ["ignore", "pipe", "ignore"],
		});
		result = output.trim() === "true";
	} catch {
		// git 不可用或非 git 仓库 — 正常情况，不报错
		result = false;
	}

	gitRepoCache.set(projectRoot, result);
	return result;
}

/**
 * 检测目录是否为项目目录（有标记文件或 git 仓库）。
 * 用于 before_agent_start hook 的快速短路判断。
 *
 * 非项目目录（如 /tmp、/var、/home）跳过 scanProject，
 * 避免在大型临时目录下同步扫描导致阻塞。
 */
export function isProjectDir(projectRoot: string): boolean {
	for (const marker of PROJECT_MARKERS) {
		if (existsSync(join(projectRoot, marker))) {
			return true;
		}
	}
	return false;
}

/**
 * 安全执行 git 命令。
 * - 非 git 仓库：直接返回 null（不 spawn git 进程）
 * - git 仓库：执行命令，抑制 stderr，返回 stdout；失败返回 null
 *
 * @param args - git 子命令参数（如 ["log", "--oneline", "-10"]）
 * @param cwd - 工作目录
 * @param timeout - 超时毫秒数（默认 5000）
 * @returns stdout 字符串，或 null（非 git 仓库/执行失败）
 */
export function safeGitExec(args: string[], cwd: string, timeout = 5000): string | null {
	// 非 git 仓库直接返回，避免 spawn 注定失败的 git 进程
	if (!isGitRepo(cwd)) return null;

	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf-8",
			timeout,
			// 抑制 stderr，防止 git 错误信息泄漏到用户终端
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

/**
 * 重置 git 缓存。仅在测试中使用。
 */
export function _resetGitCache(): void {
	gitRepoCache.clear();
}

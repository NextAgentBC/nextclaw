# openclaw-selfcare

[English](README.md) · **简体中文**

一个轻量的 OpenClaw **运维 skill**，负责将单台主机上的 OpenClaw core 与 nextclaw
（`memory-postgres`）插件保持在最新版本——而且是*安全地*升级。

OpenClaw 发布频繁。core 升级偶尔会带来一个本记忆插件尚未适配其插件 API 的 openclaw
版本，或者一个裁剪掉了插件所依赖的某个传递依赖（transitive dependency，例如 `undici`）的版本。
无论哪种情况，记忆层（memory layer）都可能在升级中途宕机。本 skill 会**在沙箱中、于触碰线上安装之前**
预测这一风险，对可安全修复的情况执行自动修复（auto-fix），其余情况则发出告警而非强行升级。

## 功能说明

```
check latest openclaw
   → sandbox preflight: does the new openclaw still load this plugin + resolve its deps?
      → PASS         : upgrade openclaw, then update the plugin, then verify
      → FIX-NEEDED   : bump plugin to a compatible tag / install the missing dep, re-check
      → FAIL         : skip the upgrade, alert (never upgrade onto a broken/incompatible state)
```

## 快速上手

```bash
# read-only status + compatibility verdict
bash oc-selfcare.sh check

# the real upgrade (preflight → upgrade → verify)
bash oc-selfcare.sh apply
```

将其作为 OpenClaw skill 安装，agent 便能回答"现在升级安全吗？"：

```bash
openclaw skills install ./skills/openclaw-selfcare --force
```

完整的命令参考、预检（preflight）裁决表、新主机 SOP（含可选的每日 cron）以及内置的安全保证，
详见 [`SKILL.md`](./SKILL.md)（该文档保持英文）。配置为可选项——参见 [`config.env.example`](./config.env.example)。

## 依赖要求

PATH 中需具备 `bash`、`node`、`npm`、`git`、`jq` 以及 `openclaw`。插件的克隆目录会通过
`openclaw plugins inspect memory-postgres` 自动定位。

## 安全性

- 只读（read-only）的 `check` / `preflight` 绝不触碰线上安装。
- `apply` 在以下情况下会拒绝升级：沙箱预检未通过；需要跨越被标记为破坏性（breaking）的发布；
  以及在一个本就不健康的安装之上叠加升级。
- 含有未提交改动的插件克隆（即开发机，dev box）会被跳过，绝不强行覆盖。
- 升级完成后，会验证（verify）网关（gateway）版本与记忆探针确实已恢复。

本项目采用 Apache-2.0 许可，与 nextclaw 其余部分一致。

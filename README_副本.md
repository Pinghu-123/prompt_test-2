---
domain:
- nlp
tags:
- prompt-engineering
- streamlit
- sqlite
license: Apache License 2.0
deployspec:
  entry_file: app.py
---

# Improve_Prompt

基于 `server_add.html`、`server_list.html`、`model_add.html`、
`model_list.html`、`prompt_dis.html`、`prompt_list.html` 原型实现的服务器、模型与提示词调试功能。

## 运行环境

- Python 3.11+
- Streamlit
- SQLite（Python 标准库自带）

安装 Streamlit：

```bash
python3 -m pip install -r requirements.txt
```

## 启动

```bash
python3 -m streamlit run app.py
```

默认访问地址：

```text
http://localhost:8501
```

可指定监听地址和端口：

```bash
python3 -m streamlit run app.py --server.address 127.0.0.1 --server.port 8501
```

首次启动会自动创建 `Prompt_Improve_DB`，并初始化 `srv`、`mdl`、`prompt` 三张表。

部署到魔搭创空间后，数据库会自动写入 `/mnt/workspace/Prompt_Improve_DB`，
首次启动时会从项目根目录的同名数据库复制现有数据。该目录在创空间重启后
仍会保留；本地运行时仍使用项目目录下的 `Prompt_Improve_DB`。

所有原型页面统一使用同一个 SQLite 数据库：

- `server_add`、`server_list` 读写 `srv`
- `model_add`、`model_list` 读写 `mdl`，并通过 `srv_id` 关联 `srv`
- `prompt_dis` 从 `srv`、`mdl` 加载服务器、模型和费用配置
- `prompt_list` 从 `prompt`、`mdl`、`srv` 联表加载已保存提示词

## 已实现

- 添加服务器并持久化到 SQLite
- 服务器列表从 SQLite 加载
- 按平台、官方名和公司名搜索
- 服务器列表刷新、重置、批量选择与删除
- 添加模型并按服务器外键保存到 SQLite
- 模型列表从 `mdl`、`srv` 联表加载
- 按平台、类型、模型名和 Token 费用区间搜索模型
- 模型列表刷新、重置、批量选择与删除
- 服务器与模型页面导航及服务器下拉数据联动
- 提示词调试页从 SQLite 联动加载服务器、`base_url`、模型与费用数据
- 服务器切换后联动刷新对应模型、模型单价及模型类型
- API Key 显示/隐藏、系统提示词复制、多轮会话增删与提示词重置
- 点击“调试”后通过服务器 `base_url` 调用真实模型接口
- 支持 OpenAI 兼容的 `/chat/completions` 接口、多轮上下文与接口错误提示
- 优先使用接口返回的 Token 用量，并据此计算输入、输出及总费用
- API Key 会自动清理首尾空白、引号及误填写的 `Bearer` 前缀
- 模型输出复制与清空，输出状态和费用指标同步更新
- 提示词列表按名称、服务器、模型或系统提示词搜索，点击“编辑”回填并保存到 SQLite
- 列表中的系统提示词最多显示前 25 个字，超出时追加省略号
- 保留原型的字段、布局、控件样式和前端必填校验

页面模板位于 `components/improve_prompt`，开发交互桥接位于
`components/improve_prompt/bridge.js`。

## 魔搭创空间部署

项目根目录已包含：

- `ms_deploy.json`：Streamlit 创空间部署配置
- `requirements.txt`：Python 依赖
- `README.md`：创空间卡片和 `app.py` 启动入口声明
- `.streamlit/config.toml`：容器内监听配置

创建创空间时选择 `Streamlit` SDK，将本目录内的文件上传到创空间根目录，
然后点击“上线”或“立即发布”即可。无需修改启动命令或额外配置端口。

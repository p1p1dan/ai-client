export type Locale = 'en' | 'zh';

export const zhTranslations: Record<string, string> = {
  Automatic: '自动',
  Media: '媒体',
  Cover: '铺满',
  Contain: '完整显示',
  Repeat: '平铺',
  Center: '居中',
  Network: '网络',
  Advanced: '高级',
  Pi: 'Pi',
  'Updated {{providers}} providers and {{models}} models.':
    '已更新 {{providers}} 个渠道、{{models}} 个模型。',
  'Yolo mode disables all permission checks, including command restrictions. Disable it in the {{source}} configuration file.':
    'Yolo 模式已开启，包括命令限制在内的所有权限检查均已失效。请在“{{source}}”对应的配置文件中关闭它。',
  'Currently set by {{source}}.': '当前由“{{source}}”设定。',
  '{{action}} will run without approval. {{description}}':
    '“{{action}}”将不再询问，Agent 可以直接执行。{{description}}',
  'Inherit default ({{action}})': '跟随默认（{{action}}）',
  'Add a {{category}} rule': '新增{{category}}规则',
  'Delete rule {{pattern}}': '删除规则 {{pattern}}',
  'Reveal {{scope}} in file manager': '在文件管理器中显示{{scope}}',
  '{{reason}} (syntax error: {{error}})': '{{reason}}（该文件另有语法错误：{{error}}）',
  'This rule stays at position {{position}}. The {{count}} later rules take precedence.':
    '该规则保留在第 {{position}} 条，它后面还有 {{count}} 条规则，命中时以后面的为准。',
  Cached: '缓存',
  // A3: the catalog that shipped inside this build, distinct from `Cached`
  // (which this machine fetched once) and from `Unavailable`.
  'Shipped baseline': '随包基线',
  'Model catalog unreachable — showing the list this build shipped with':
    '模型目录不可达 —— 正在显示本次构建随包的基线列表',
  'Local setup': '本地配置',
  'Pi model management': 'Pi 模型管理',
  Syncing: '同步中',
  'Sync now': '立即同步',
  'Model metadata is synced to the managed directory. Your account supplies the API key.':
    '登录模式从管理端同步模型元数据到隔离目录；API key 仍由账号登录注入。',
  'Using your own setup. Pi reads your configuration from ~/.pi/agent.':
    '当前是 “Use my own setup”，Pi 会直接读取你自己的 ~/.pi/agent 配置。',
  'Management server': '管理端',
  'Configuration URL': '配置地址',
  Providers: '渠道',
  Models: '模型',
  'Last successful sync': '上次成功',
  'Last attempt': '上次尝试',
  'Managed directory:': '隔离目录：',
  'The default URL points to /api/v1/models-config on the onboarding service.':
    '默认地址随版本内置，指向 onboard 服务的 /api/v1/models-config；填别的地址可指向另一套部署。',
  'The management page is at /admin and requires the server administrator password.':
    '管理页在同一服务的 /admin 下，进入需要服务端配置的管理口令。',
  'Sync requires a signed-in account because the configuration may contain provider credentials.':
    '拉取会带上你登录拿到的 key：配置里可能含管理员为某个渠道填的密钥，所以这个接口只对已登录的客户端开放。',
  'Default actions': '各类操作的默认处理',
  'Choose whether each tool call is allowed, requires approval, or is denied.':
    'agent 每次调用工具时，闸门按这里的设置决定是直接放行、弹窗询问，还是直接拒绝。',
  'Approval log': '审批日志',
  'Record allowed and denied actions for review.': '记录每一次放行与拒绝，供事后追查。',
  'Record approval results': '记录审批结果',
  'Write to': '写入',
  'Using the plugin default.': '当前是插件自带的默认值。',
  'Configuration sources': '配置来源',
  'Lower entries take precedence. The last layer defining a setting determines its value.':
    '越靠下的层级优先级越高。同一条设置由最后一个写它的层决定。',
  'Reset my permission overrides': '清空我的设置，恢复出厂策略',
  'Remove this protection?': '确认取消这一层保护？',
  'Allow anyway': '仍然直接允许',
  'Review the policy applied before Pi tool calls and edit your own overrides.':
    'Pi 后端每次调用工具前都会先过这道闸。这里能看到它当前的判断依据，并修改属于你的那一层。',
  Allow: '直接允许',
  'Ask every time': '每次询问',
  Deny: '直接拒绝',
  'Inherit default': '跟随默认',
  'No rules in this category.': '这一类还没有任何规则。',
  'e.g. npm test *': '例如 npm test *',
  'e.g. ~/secrets/*': '例如 ~/secrets/*',
  'Action for the new rule': '新规则的处理方式',
  'This rule was changed but retains its original position':
    '这条规则被你改过，但仍留在原来的位置上',
  'Position unchanged': '位置未变',
  'Bundled defaults': '随包默认',
  'My settings': '我的设置',
  'Project configuration': '项目配置',
  'Plugin defaults': '插件自带默认',
  'Not created': '未创建',
  Ignored: '被忽略',
  Invalid: '无法解析',
  'Changes are saved here': '本面板写这里',
  'Bundled policy with the lowest priority; your settings override it':
    '本应用出厂策略，优先级最低，你的设置永远压得过它',
  'Account-specific Pi directory where your changes are saved':
    '按帐号隔离的 pi 目录，本面板的改动写在这里',
  'Repository .pi configuration with the highest priority': '仓库自带的 .pi 配置，优先级最高',
  'File does not exist; this layer contributes no rules': '文件不存在，本层不产生任何规则',
  'Read files': '读取文件',
  'Open individual files, subject to the file path rules below.':
    '打开单个文件。仍受下方“文件路径”规则约束。',
  'Search file contents.': '在文件里按内容搜索。',
  'List directories': '列目录',
  'List directory contents.': '列出目录内容。',
  'Find files': '查找文件',
  'Find files by name.': '按文件名查找。',
  'Write files': '写入文件',
  'Create or overwrite files. Allowing this skips approval before writing.':
    '新建或覆盖文件。设为“直接允许”后，写错的文件没有任何一步可以拦下。',
  'Edit files': '修改文件',
  'Edit existing files. Allowing this skips approval before editing.':
    '改动已有文件。设为“直接允许”后，改错的地方没有任何一步可以拦下。',
  'Terminal commands (default)': '终端命令（默认）',
  'Applies to commands not matched below. Allowing this permits arbitrary commands.':
    '没有被下方白名单命中的命令走这里。设为“直接允许”等于让 agent 可以执行任意命令。',
  'Access outside the working directory': '访问工作目录之外',
  'Controls reading and writing outside the current repository.':
    '离开当前仓库去读写别处。这是阻止一个仓库的会话动到另一个仓库的那道闸。',
  'MCP tool calls': 'MCP 工具调用',
  'Call tools provided by external MCP servers.': '调用外部 MCP 服务器提供的工具。',
  'Run packaged skills, which may call other tools.': '运行打包好的技能。技能内部可以再调工具。',
  'Other tools (fallback)': '其它一切（兜底）',
  'Any tool not listed above, including tools provided by new extensions.':
    '上面没有提到的任何工具，包括这个版本还没见过的扩展工具。',
  'File paths': '文件路径',
  'Applies before other rules across all tools. A path denial overrides a tool allowance.':
    '横切所有工具，先于其它规则判定，且这里的“拒绝”不能被单个工具的“允许”覆盖——这就是 cat 可以放行而 cat .env 仍被拒的原因。',
  'Allowed terminal commands': '终端命令白名单',
  'Matching commands skip approval. Later rules take precedence.':
    '命中的命令不再弹窗。越靠后的规则优先级越高。',
  'A rule cannot be empty': '规则不能为空',
  'A rule cannot start or end with spaces': '规则首尾不能有空格',
  'This rule exists and its action will be replaced': '该规则已存在，将被覆盖为新的动作',
  'Action Panel': '操作面板',
  'Add Repository': '添加仓库',
  'Add a repository to get started.': '添加一个仓库开始使用。',
  'Add Workspace': '新建工作区',
  'Add agent': '添加 Agent',
  'Add to favorites': '添加收藏',
  'Remove from favorites': '取消收藏',
  Agent: 'Agent',
  'Agent session shortcuts': '设置 Agent 会话管理快捷键',
  All: '全部',
  'Already at the first change': '已经是第一处差异',
  'Already at the last change': '已经是最后一处差异',
  'App-wide shortcuts': 'APP 全局快捷键',
  'Apply on new terminals': '更改后新建终端生效',
  'Apply on new terminals or restart': '更改后需新建终端或重启应用才能生效',
  'Apply on new terminals only': '更改后需新建终端才能生效',
  'Are you sure you want to delete worktree {{name}}?': '确定要删除 worktree {{name}} 吗？',
  'Are you sure you want to discard changes to {{path}}? This cannot be undone.':
    '确定要撤销 {{path}} 的更改吗？此操作不可恢复。',
  'Are you sure you want to exit the app?': '确定要退出应用吗？',
  'Are you sure you want to remove {{name}} from the workspace?':
    '确定要从工作区移除 {{name}} 吗？',
  'Also delete branch {{name}}': '同时删除分支 {{name}}',
  'Animated glow border for AI output states': 'AI 输出状态的动态发光边框',
  Background: '背景',
  'Background Image': '背景图片',
  'Custom background image for the workspace': '自定义工作区背景图片',
  'Source Type': '来源类型',
  'Image / Video File': '图片 / 视频文件',
  'Folder (Random)': '文件夹（随机）',
  'Source Path': '来源路径',
  'Select a folder containing images or videos': '选择包含图片或视频的文件夹',
  'Local file path or URL': '本地文件路径或 URL',
  'Paste remote image URL (http/https)': '粘贴远程图片 URL（http/https）',
  'URL (Auto Refresh)': 'URL（自动刷新）',
  'URL Mode': 'URL 模式',
  'Select File': '选择文件',
  'Select Folder': '选择文件夹',
  'Select a folder': '选择文件夹',
  'Auto Random': '自动随机',
  'Interval (seconds)': '间隔（秒）',
  'Source Directory': '来源目录',
  'Image Path': '图片路径',
  Opacity: '不透明度',
  Blur: '模糊度',
  Brightness: '亮度',
  Saturation: '饱和度',
  'More Options': '更多选项',
  'Size Mode': '填充模式',
  'Select Image': '选择图片',
  'Beta Features': 'Beta 功能',
  'Binary file not supported for diff preview': '二进制文件不支持差异预览',
  'Temp Session': '临时会话',
  'Session History': '会话历史',
  'Temp Session settings': '临时会话设置',
  'Show Temp Session entry for quick scratch sessions': '显示临时会话入口，用于快速临时会话',
  'Default directory for new temp sessions. Leave empty to use ~/JYWAI/temporary':
    '新建临时会话的默认目录。留空则使用 ~/JYWAI/temporary',
  'Automatically create Agent/Terminal Session when activating a temp session':
    '激活临时会话时自动创建 Agent / 终端会话',
  'No temp sessions': '暂无临时会话',
  'Create a temp session to get started': '点击“新建临时会话”开始一次临时会话',
  'New Temp Session': '新建临时会话',
  'Rename temp session': '重命名临时会话',
  'Delete temp session?': '删除临时会话？',
  'This will delete the temp session directory and its contents.':
    '此操作将删除该临时会话目录及其内容。',
  'Temp Session created': '临时会话已创建',
  'Temp Session deleted': '临时会话已删除',
  'Failed to create temp session': '创建临时会话失败',
  'Failed to delete temp session': '删除临时会话失败',
  Branch: '分支',
  'Branch already exists. Choose a different name.': '该分支已存在，请使用其他分支名',
  'Branch name': '新分支名',
  Cancel: '取消',
  '{{count}} pending approval requests': '{{count}} 个待审批请求',
  'Could not send your answer. Please try again.': '无法发送你的回答，请重试。',
  'Cancel staging all': '全部取消暂存',
  'Change list': '更改',
  Changes: '更改',
  'Changes ({{count}})': '更改 ({{count}})',
  'Changed files ({{count}})': '更改的文件 ({{count}})',
  'Confirm Move': '确认移动',
  'Are you sure you want to move this file/folder?': '确定要移动此文件/文件夹吗？',
  'Are you sure you want to move "': '是否要将"',
  '" to "': '"移动到"',
  '"?': '"?',
  "Don't show again": '不再提醒',
  'Continue as {{email}}': '以 {{email}} 继续',
  'Log in with work email': '用工作邮箱登录',
  'Use my own setup': '使用本机已有配置',
  // The two blurbs that used to sit under the entry buttons are gone with them
  // (2026-09-11), and so are their entries — an orphaned key is a translation
  // someone will later maintain for a screen that no longer shows it.
  'Your session expired. Sign in again.': '登录已失效，请重新登录。',
  'Git was not found on this computer': '这台电脑上没有找到 Git',
  'Worktrees, branches and source control need Git. Everything else still works.':
    '工作树、分支与源代码管理需要 Git，其余功能不受影响。',
  'Install Git': '安装 Git',
  'Get Git': '去下载 Git',
  Dismiss: '关闭',
  'Check for updates later': '稍后',
  'Check for updates': '检查更新',
  'Check failed': '检查失败',
  'Checking...': '检查中...',
  'Connecting...': '连接中...',
  Reconnecting: '重连中',
  'Reconnecting remote connection...': '正在重连远程连接...',
  'Remote connection lost. Attempting to reconnect...': '远程连接已断开，正在尝试重连...',
  'Remote connection lost': '远程连接已断开',
  'Remote terminal reconnecting...': '远程终端正在重连...',
  'Remote terminal disconnected': '远程终端已断开',
  'Remote terminal input is temporarily disabled while reconnecting.':
    '远程终端正在重连，输入暂时不可用。',
  'Remote terminal has disconnected. Reconnect the remote host to continue.':
    '远程终端已断开，请重新连接远程主机后继续。',
  characters: '字符',
  Chat: '聊天',
  'Choose base branch...': '选择基准分支...',
  'Choose branch...': '选择分支...',
  'Choose how the settings window is displayed': '选择设置窗口的显示方式',
  'Choose workspace first': '请先选择一个工作区',
  'Choose Worktree': '选择 Worktree',
  'Clear terminal': '清除终端',
  'Split Terminal': '分屏',
  'Split Agent': '分屏',
  'Merge Terminal': '合并分屏',
  'Merge Agent': '合并分屏',
  'Split pane': '分屏',
  'Merge pane': '合并分屏',
  'Shortcuts for terminal and agent sessions': '终端和 Agent 会话快捷键',
  'Option as Meta': 'Option 作为 Meta',
  'Use Option key as Meta instead of composing special characters':
    '将 Option 键作为 Meta 键使用，而非输入特殊字符（如 π）',
  'Click to load worktrees': '点击加载 worktrees',
  'Click the selected repository again to connect and load worktrees.':
    '再次点击当前仓库以连接并加载 worktree。',
  Close: '关闭',
  'Close Session': '关闭会话',
  'Close Tab': '关闭标签',
  'Close Others': '关闭其他',
  'Close Tabs to the Left': '关闭左侧所有',
  'Close Tabs to the Right': '关闭右侧所有',
  'Close All Tabs': '关闭所有',
  Collapse: '折叠',
  'Collapse all': '折叠所有',
  'Collapse all folders': '折叠所有文件夹',
  'Collapse file tree': '折叠文件树',
  'Collapse Repository': '折叠仓库',
  'Collapse Worktree': '折叠 Worktree',
  'Color scheme': '配色',
  Command: '命令',
  Commit: '提交',
  'Commit failed': '提交失败',
  'Commit in progress...': '提交中...',
  'Commit message': '提交信息',
  'Commit successful': '提交成功',
  'Committed {{count}} files': '已提交 {{count}} 个文件',
  Conflict: '冲突',
  Copied: '已复制',
  'Copied to clipboard': '已复制到剪贴板',
  Copy: '复制',
  'Open Folder': '打开文件夹',
  'Copy Commit ID': '复制 Commit ID',
  'Copy Path': '复制路径',
  'Copy Relative Path': '复制相对路径',
  'Revert commit': 'Revert 提交',
  'Reset to commit': 'Reset 到此提交',
  'Select reset mode for commit': '选择 Reset 模式',
  'Soft Reset': '软重置',
  'Mixed Reset': '混合重置',
  'Hard Reset': '硬重置',
  'Keep all changes staged': '保留所有更改（已暂存）',
  'Unstage all changes': '取消暂存所有更改',
  'Revert successful': 'Revert 成功',
  'Revert failed': 'Revert 失败',
  'Commit has been reverted': '提交已 Revert',
  'Reset successful': 'Reset 成功',
  'Reset failed': 'Reset 失败',
  'Reset to {{mode}} mode': '已 Reset 到 {{mode}} 模式',
  'Path copied to clipboard': '路径已复制到剪贴板',
  'Reveal in Finder': '在 Finder 中显示',
  'Reveal in Explorer': '在资源管理器中显示',
  'Quick scratch sessions': '快速临时会话',
  Cut: '剪切',
  Paste: '粘贴',
  Color: '颜色',
  'Custom color': '自定义颜色',
  Create: '创建',
  'Create in progress...': '创建中...',
  'Create new branch': '创建新分支',
  'Create Worktree': '创建 Worktree',
  'Create workspace': '新建工作区',
  'Create a new branch and work in a separate directory to handle multiple tasks.':
    '创建新分支并在独立目录中工作，可同时处理多个功能',
  Current: '当前',
  'Current Window': '当前窗口',
  'Custom Agent': '自定义 Agent',
  'Custom CLI tools': '添加自定义 CLI 工具',
  Default: '默认',
  Delete: '删除',
  'Delete all': '全部删除',
  'Delete all untracked files': '删除所有未跟踪文件',
  'Delete Group': '删除分组',
  Deleted: '删除',
  'Delete file': '删除文件',
  'Delete Worktree': '删除 Worktree',
  Description: '描述',
  'Description (optional)': '描述 (可选)',
  // F09: `Reload` / `Developer Tools` / `GitHub` / `Exit` were the title bar's
  // overflow menu, which is gone. `Developer Tools` was the only one with an
  // entry here, and it is dropped with the control it labelled — a translation
  // for a string nothing renders is a shell waiting to be mistaken for a live
  // one. It stays reachable through the platform's own F12.
  Announcements: '公告',
  // F10: `This month calls` retired with the tile it labelled — a call count is
  // not what runs out. `Weekly limit` took its place.
  'Weekly limit': '周限额',
  'Not available': '暂不可用',
  Remaining: '剩余',
  'Over limit': '已超出',
  'Announcements (unread)': '公告（有未读）',
  'Messages from the service operator.': '来自服务方的通知。',
  'Got it': '知道了',
  'AI Client': 'AI Client',
  Diffs: '差异',
  Discard: '撤销更改',
  'Discard all': '全部撤销',
  'Discard all changes': '撤销所有更改',
  'Discard changes': '撤销更改',
  'Discard changes title': '撤销更改',
  'Discard failed': '撤销更改失败',
  Disabled: '禁用',
  'Downloading update': '正在下载更新',
  Edit: '编辑',
  'Edit Agent': '编辑 Agent',
  'Edit Group': '编辑分组',
  English: '英语',
  'Enter a new branch name:': '输入新分支名:',
  Group: '分组',
  'Enter a name for the new file.': '输入新文件的名称。',
  'Enter a name for the new folder.': '输入新文件夹的名称。',
  'Enter commit message... (Cmd/Ctrl+Enter to commit)': '输入提交信息... (Cmd/Ctrl+Enter 提交)',
  'Enter new branch name': '请输入新分支名',
  'Error deleting': '删除失败',
  'Expand all': '展开所有',
  'Expand all folders': '展开所有文件夹',
  'Expand Repository': '展开仓库',
  'Expand Worktree': '展开 Worktree',
  'Expand File Sidebar': '展开文件侧栏',
  Favorites: '收藏',
  'Failed to create': '创建失败',
  'Failed to load diff': '无法加载差异',
  File: '文件',
  Files: '文件',
  'Filter actions...': '搜索操作...',
  Font: '字体',
  'Font size': '字号',
  'Font weight': '字重',
  'Force delete (ignore uncommitted changes)': '强制删除（忽略未提交的修改）',
  'Folder diff totals': '该目录未提交：+{{insertions}} 行 / -{{deletions}} 行',
  General: '通用',
  Git: 'Git',
  'Git not initialized': '不是 Git 仓库',
  // Git Submodules
  Submodules: '子模块',
  'No submodules': '没有子模块',
  'Init all submodules': '初始化所有子模块',
  'Update all submodules': '更新所有子模块',
  'Sync submodule URLs': '同步子模块 URL',
  Fetch: '获取',
  'Fetch failed': '获取失败',
  'Push failed': '推送失败',
  'Stage failed': '暂存失败',
  'Unstage failed': '取消暂存失败',
  '{{count}} staged': '{{count}} 个已暂存',
  '{{count}} unstaged': '{{count}} 个未暂存',
  Global: '全局',
  'Glow Effect': '发光效果',
  'Go to download': '前往下载',
  Head: '头',
  Help: '帮助',
  'Hide changed files': '隐藏更改文件',
  'Hide sidebar': '隐藏侧边栏',
  History: '历史',
  'Immediate restart': '立即重启',
  'Initializing repository': '初始化仓库',
  Keybindings: '快捷键',
  Language: '语言',
  Layout: '布局',
  'Last updated': '最近提交',
  Light: '浅色',
  'List view': '列表视图',
  'Loading...': '加载中...',
  'Local branches': '本地分支',
  Look: '外观',
  'Manage Agent sessions': '设置 Agent 会话管理快捷键',
  Main: 'Main',
  Merged: '已合并',
  Modified: '修改',
  More: '查看更多',
  'Move to Group': '移动到分组',
  Name: '名称',
  New: '新建',
  'New File': '新建文件',
  'New Group': '新建分组',
  'Group Name': '分组名称',
  'New Folder': '新建文件夹',
  'New Session': '新建会话',
  'New Tab': '新建标签',
  'New Terminal': '新建终端',
  'New Worktree': '新建 Worktree',
  'No branches found': '未找到分支',
  'No branches available': '暂无可用分支',
  'Branch switched': '分支已切换',
  'Branch switched to {{branch}}': '已切换到分支 {{branch}}',
  'Failed to switch branch': '切换分支失败',
  'Create new branch...': '创建新分支...',
  'Branch name...': '分支名称...',
  'Branch created': '分支已创建',
  'Failed to create branch': '创建分支失败',
  'No changes': '没有更改',
  'No files': '没有文件',
  'No commits yet': '暂无提交记录',
  'No Group': '无分组',
  Ungrouped: '未分组',
  'No file changes in this commit': '此提交没有文件更改',
  'No staged changes': '没有暂存的更改',
  'No matching actions found': '没有找到匹配的操作',
  'No matching repositories': '未找到仓库',
  'No matching worktrees': '未找到匹配',
  'No matching results': '没有匹配结果',
  'No matching workspaces': '未找到匹配的工作区',
  'No remote tracking branch': '未关联远程分支',
  'No running projects': '暂无运行中的项目',
  'No themes found': '未找到主题',
  'No workspaces': '暂无工作区',
  'No worktrees': '暂无 Worktree',
  'No worktrees. Create one to get started.': '暂无 Worktree，创建一个开始工作',
  'Not installed': '未安装',
  'Not detected': '未检测',
  'No agent sessions': '暂无 Agent 会话',
  'No enabled agents': '没有已启用的 Agent',
  'No terminals open': '暂无终端',
  'Create a terminal to start working': '创建终端以开始工作',
  'Create a session to start using AI Agent': '创建一个会话，开始使用 AI Agent',
  'File Explorer': '文件浏览器',
  'Select a Worktree': '选择 Worktree',
  'Select a Worktree to browse files': '选择 Worktree 以浏览文件',
  'Select a Worktree to open terminal': '选择 Worktree 以打开终端',
  'Choose a worktree to continue using AI Agent': '选择 Worktree 以继续使用 AI Agent',
  'Notification delay': '空闲时间',
  'Timed out': '检测超时',
  'Open in Finder': '在 Finder 中显示',
  'Open in IDE': '在 IDE 中打开',
  'Open in {{app}}': '在 {{app}} 打开',
  'Open settings': '打开设置',
  // R02-c slash command menu.
  'Start a new conversation': '开始一个新对话',
  'Archive this conversation': '归档当前对话',
  'Compact the context of this conversation': '压缩当前对话的上下文',
  'Remote repository is not connected yet': '远程仓库尚未连接',
  'Open terminal': '在终端中打开',
  'Open with': '打开方式',
  'Open folder': '打开文件夹',
  Panel: '面板',
  'Pending changes': '未暂存的更改',
  'Performance warning': '性能警告',
  'Please select a workspace first.': '请先选择一个工作区',
  'Please select a worktree first': '请先选择一个 Worktree',
  Primary: '主',
  Publish: '发布',
  'Publish branch to remote': '发布分支到远程',
  'Publish failed': '发布失败',
  'Branch published': '分支已发布',
  'Branch {{branch}} is now tracking origin/{{branch}}':
    '分支 {{branch}} 现在跟踪 origin/{{branch}}',
  Refresh: '刷新',
  'Refresh enabled agents': '刷新已启用的 Agent',
  'Refresh terminal': '刷新终端',
  'File Already Exists': '文件已存在',
  'A file or folder with this name already exists in the destination.':
    '目标位置已存在同名文件或文件夹。',
  From: '从',
  To: '到',
  Rename: '重命名',
  Renamed: '重命名',
  Replace: '替换',
  Remove: '移除',
  'Remove repository': '移除仓库',
  'Remove repository confirm': '移除仓库',
  'Remove repository description': '此操作只会从应用中移除，不会删除本地文件。',
  'Repository Settings': '仓库设置',
  'Repository actions': '仓库操作',
  Repositories: '仓库列表',
  'Auto-initialize new worktrees': '自动初始化新 Worktree',
  'Automatically run init script when creating new worktrees':
    '创建新 Worktree 时自动运行初始化脚本',
  'Init Script': '初始化脚本',
  'e.g., pnpm install && pnpm dev': '例如 pnpm install && pnpm dev',
  'Commands to run after creating a new worktree. Multiple commands can be separated by && or newlines.':
    '创建新 Worktree 后运行的命令。多个命令可用 && 或换行分隔。',
  Renderer: '渲染器',
  'Reset on new terminal': '更改后新建终端生效',
  Resume: '继续',
  'Running Projects': '运行中的项目',
  'Search branches...': '搜索分支...',
  'Search emoji...': '搜索 emoji...',
  'Search repositories': '搜索仓库',
  'Search running projects...': '搜索运行中的项目...',
  'Search workspaces...': '搜索工作区...',
  'Search worktrees...': '搜索 worktree...',
  'Search worktrees': '搜索 worktree',
  'Search sessions': '搜索会话',
  // Shared by the two terminals' scrollback buttons and the chat timeline's
  // bottom anchor (T12-d) — one wording for one gesture, in both places.
  'Scroll to bottom': '滚动到底部',
  // Pi runs as a local PTY, so a remote workspace has no directory to spawn in.
  'Pi terminal is unavailable for remote repositories': 'Pi 终端不支持远程仓库',
  'Open a local repository or worktree to start a Pi terminal.':
    '请打开本地仓库或 worktree 后再启动 Pi 终端。',
  'New chat': '新建对话',
  // D1 (round-5): header "New" button title, dynamic target discoverability.
  'New session in {{folder}}': '在 {{folder}} 中新建会话',
  // T026: sidebar capability entry. Per session on purpose — MCP servers,
  // skills and sub-agents are all resolved from the session's own working
  // directory. It replaced U04's pi extension list, which P6-5 left empty.
  Capabilities: '能力',
  'MCP servers, skills and sub-agents this chat brought up.':
    '这个对话启用的 MCP 服务、技能与子智能体。',
  'MCP servers': 'MCP 服务',
  'Send a message to start this chat and see what it brings up.':
    '发送一条消息启动这个对话后，才能看到它启用了什么。',
  'Pi extensions you install are loaded only by the built-in terminal.':
    '你安装的 pi 扩展只会被内嵌终端加载。',
  // R04: Settings → Resources. These are installation locations, not the
  // rejected pix-style Resources navigation entry.
  Resources: '资源',
  'Pi Resources': 'Pi 资源',
  'Install skills and prompt templates where Pi can load them reliably.':
    '把技能与提示词模板安装到 Pi 能稳定加载的位置。',
  'Loading resource settings...': '正在读取资源设置…',
  'Shared skills': '共享技能',
  Recommended: '推荐',
  Skills: '技能',
  // chat-tool-04: body label of the skill approval card (runtime emits
  // preview.label='Skill' and the card looks it up via t()). Distinct from the
  // plural 'Skills' key; the two must not substitute for each other.
  Skill: '技能',
  'Prompt templates': '提示词模板',
  'This cross-agent location is always loaded in managed mode, local mode, and the Pi TUI.':
    '这个跨 Agent 共享位置在托管模式、本机模式与 Pi TUI 中都会加载。',
  // H/19: 两种模式共用同一个目录，所以这里只剩「本应用的」和「你自己的」两块。
  // 借用开关连同它的四条文案一起删掉了——机制没了，留着文案会被下一次搜索翻出来当成还在。
  'This app\u2019s Pi directory': '本应用的 Pi 目录',
  'Every session in this app — signed in or using your own setup, GUI or Pi TUI — loads skills and prompt templates from here. Installed pi extensions are loaded from here by the Pi TUI only.':
    '本应用里的每个会话——无论是登录模式还是「使用我自己的配置」，无论 GUI 还是 Pi TUI——都从这里加载技能与提示词模板；已安装的 pi 扩展只有 Pi TUI 会从这里加载。',
  'Your personal Pi directory': '你自己的 Pi 目录',
  'Where the Pi CLI in your own terminal reads from. This app never writes here, and no longer loads from here — use the copy step above to bring things over.':
    '你自己终端里的 Pi CLI 读取的位置。本应用从不写入这里，也不再从这里加载——要把东西搬过来，用上面的复制步骤。',
  // cutover-10: no longer "bundled extensions" — the packages behind this
  // section were retired in T025, and the one switch left turns a feature of
  // this app's own runtime on and off.
  'Agent features': '智能体功能',
  'Sub-agents': '子智能体',
  'Lets the model delegate work to background agents. On unless you turn it off: its tool definitions are sent with every request, so it costs tokens on every turn even when unused. Changing it reloads workers.':
    '让模型把任务派给后台智能体。默认开启，除非你自己关掉：它的工具定义会随每次请求一起发送，即使用不到也每轮都在花 token。切换后会重新加载 worker。',
  'Open prompt templates folder': '打开模板目录',
  'Open skills folder': '打开技能目录',
  'Opening...': '正在打开…',

  // P5-2-5：原生子代理的管理界面。
  Subagents: '子代理',
  'Background delegates the model can start with Task. Each one runs on its own context and reports back when it finishes.':
    '模型可以用 Task 在后台启动的子代理。每个跑在自己的上下文里，做完再把报告交回来。',
  'Search by name, description or tool': '按名称、说明或工具搜索',
  'Search subagents': '搜索子代理',
  'Open subagents folder': '打开子代理目录',
  // subagent-data-01 — the legacy import entry on the subagents settings page.
  'Import old definitions': '导入旧定义',
  'These are the documents in your previous agents folder. Importing copies one into the subagents folder; the original file is left where it is.':
    '这些是你旧 agents 目录里的文档。导入会把它复制到 subagents 目录，原文件保持不动。',
  'Nothing to import — that folder has no definitions.': '没有可导入的内容 —— 那个目录里没有定义。',
  'Needs a decision': '需要先决定',
  'Name already used': '名字已被占用',
  'Import {{name}}': '导入 {{name}}',
  'Import {{count}} selected': '导入选中的 {{count}} 项',
  'New subagent': '新建子代理',
  'Loading subagents...': '正在载入子代理…',
  'No subagents yet.': '还没有子代理。',
  'No subagent matches that.': '没有匹配的子代理。',
  'Built in': '内置',
  'Switched off': '已关闭',
  'Enable {{name}}': '启用 {{name}}',
  'Edit {{name}}': '编辑 {{name}}',
  'Customise {{name}}': '定制 {{name}}',
  'Show {{name}} in folder': '在目录中显示 {{name}}',
  'Delete {{name}}': '删除 {{name}}',
  'Delete {{name}}?': '删除 {{name}}？',
  'This removes the definition file. Sessions already running keep the copy they started with.':
    '这会删掉定义文件。已经在跑的会话仍用它启动时的那份快照。',
  'These documents do not load': '这些文档加载不了',
  '{{count}} switched-off names no longer match any subagent — they were renamed or deleted.':
    '有 {{count}} 个已关闭的名字对不上任何子代理了——它们被改名或删除了。',
  'Clear them': '清理掉',
  'When to delegate here': '什么时候派给它',
  'The model reads this to choose. One line.': '模型靠这句话决定要不要派活。一句话。',
  Tools: '工具',
  'Leave empty to follow the session model. Written as provider/model.':
    '留空则跟随会话模型。写成 provider/model。',
  'Thinking level': '思考强度',
  'Follow the session': '跟随会话',
  'Turn cap': '轮次上限',
  'Empty means unlimited. Up to {{max}}.': '留空即不限。最多 {{max}}。',
  unlimited: '不限',
  Instructions: '指令',
  'The whole system prompt this subagent runs on.': '这个子代理运行时的完整系统提示词。',

  // H/19 U2：把 ~/.pi/agent 复制到本应用目录的那一段。
  'Bring over your personal Pi setup': '把你自己的 Pi 配置搬过来',
  'Copies from your own Pi directory into this app. Your files stay where they are — nothing is moved or changed there.':
    '从你自己的 Pi 目录复制到本应用。你的文件原地不动——那边不会被移动，也不会被修改。',
  'Copy from': '来源',
  'Copy to': '去向',
  'Conversation history': '历史对话',
  'AGENTS.md': 'AGENTS.md',
  // H/21 point-check D4: this sat untranslated next to 「历史对话」 and
  // 「提示词模板」 in the same list — one row English, the next Chinese.
  // `migrationKindLabel` is the single source for all five kinds; the other
  // four already had entries.
  'AI services': 'AI 服务',
  'Already here': '已经有了',
  'Replace items this app already has': '替换本应用已经有的同名项',
  'Off: anything already here is left alone.': '关闭时：这边已经有的一律保持不动。',
  'Copy selected': '复制选中项',
  'Copying...': '正在复制…',
  'Copy finished': '复制完成',
  '{{count}} already exist here and will be kept unless you allow replacing.':
    '有 {{count}} 项这边已经存在；除非你打开替换开关，否则会保持原样。',
  '{{copied}} copied, {{replaced}} replaced, {{skipped}} left alone':
    '复制 {{copied}} 项，替换 {{replaced}} 项，保持原样 {{skipped}} 项。',

  // H/21 C5：从 Claude Code / Codex 导入历史对话。
  'Import conversations from Claude Code / Codex': '从 Claude Code / Codex 导入历史对话',
  'Copies conversation history off this machine into this app, where you can read it and keep talking. The original files are only read, never changed.':
    '把这台机器上的历史对话复制进本应用，进来之后可以看、也可以接着聊。原来的文件只读不改。',
  'No Claude Code or Codex conversations were found on this machine.':
    '这台机器上没有找到 Claude Code 或 Codex 的历史对话。',
  'This project has no conversations to import.': '这个项目下没有可导入的对话。',
  'No matching folder': '未匹配到仓库',
  'No working folder was recorded': '没有记录工作目录',
  'This folder is not one of your projects here, so these conversations import as temporary chats.':
    '这个目录不在本应用的项目列表里，所以这些对话会作为临时对话导入。',
  'Import selected ({{count}})': '导入所选（{{count}}）',
  'Importing...': '正在导入…',
  Rescan: '重新扫描',
  Back: '返回',
  '{{count}} conversations': '{{count}} 个对话',
  'Imported {{imported}}, already here {{skipped}}, failed {{failed}}.':
    '新导入 {{imported}} 个，已存在 {{skipped}} 个，失败 {{failed}} 个。',
  'Imported conversations appear in the sidebar; open one to keep talking.':
    '导入的对话会出现在侧栏，打开就能接着聊。',

  // H/21 P1：首启只弹一次的迁移对话框。
  'Found an existing Pi setup on this machine. Copying it over takes a moment and changes nothing in your own directory.':
    '这台机器上有你自己的 Pi 配置。搬过来只要一会儿，你原来的目录不会有任何改动。',
  'Your AI services include API keys. Copying them stores a copy in this app’s own credential vault. Uncheck that row to leave them out.':
    '「AI 服务」里带着 API key。复制过来会在本应用自己的密钥库里存一份。不想这样就把那一行的勾去掉。',
  'Anything this app already has is left alone. You can do this later in Settings.':
    '本应用这边已经有的一律不动。现在不弄也行，以后在设置里随时可以做。',
  // Three distinct answers. 「以后再说」really does mean later — the offer comes
  // back next launch — and 「不再询问」is the only permanent one.
  'Not now': '以后再说',
  'Don’t ask again': '不再询问',

  // H/21 点验 D4 收尾：一次把渲染层里所有走 t() 却没有词条的字符串补齐。
  // 此前 57 处散落在设置、Git、差异视图、用户资料等页面，中文界面里直接显示英文；
  // 同目录的 i18nCoverage 测试从此守住这条线，新增 t() 字面量必须同时加词条。
  'A key is stored. Leave empty to keep it.': '已存有密钥。留空即保持不变。',
  'API key': 'API key',
  'API style': '接口风格',
  'Accept all ours': '全部用我方',
  'Accept all theirs': '全部用对方',
  'Add AI service': '添加 AI 服务',
  'Add a local repository, clone from Git, or bind a repository on an SSH host.':
    '添加本地仓库、从 Git 克隆，或绑定 SSH 主机上的仓库。',
  'Add repository domain': '添加仓库域名',
  'Adding...': '正在添加…',
  'Archive session': '归档会话',
  'Archive “{{name}}”? It will be removed from the sidebar.': '归档「{{name}}」？它会从侧栏移除。',
  'Arguments (e.g. {{example}})': '启动参数（例如 {{example}}）',
  'Choose directory': '选择目录',
  Cloning: '正在克隆',
  'Confirm logout': '确认退出登录',
  'Could not reach this service — {{reason}}': '连不上这个服务 —— {{reason}}',
  Custom: '自定义',
  'Directory unavailable': '目录不可用',
  'Edit AI service': '编辑 AI 服务',
  'Edit file': '编辑文件',
  'Edit repository domain': '编辑仓库域名',
  Effort: '思考强度',
  'Enter a new title': '输入新标题',
  'Exit edit mode': '退出编辑模式',
  'Failed to add remote repository': '添加远程仓库失败',
  'Failed to browse remote directories': '浏览远程目录失败',
  'Failed to clear onboarding state.': '清除引导状态失败。',
  'Failed to save file': '保存文件失败',
  'Fetch models': '获取模型列表',
  'File is too large to preview': '文件过大，无法预览',
  'File saved': '文件已保存',
  'Generate branch names with AI': '用 AI 生成分支名',
  'Just a really good one to code with ai.': '一个好用的 AI 编程工具。',
  'Loading Pi...': '正在启动 Pi…',
  Logout: '退出登录',
  'Logout failed': '退出登录失败',
  'No favorite themes yet. Click the heart icon to add favorites.':
    '还没有收藏的主题。点心形图标即可收藏。',
  'Open TUI': '打开 TUI',
  'Pi terminal disconnected': 'Pi 终端已断开',
  // T065 — the Pi TUI's own notices. `Pi TUI closed` and the line under it were
  // hardcoded English in `usePresentationSwitch.ts`; the two `reason` strings
  // below are dictionary keys Main sends across IPC (it has no translator).
  'Pi TUI closed': 'Pi 终端已关闭',
  'Returned to the GUI session.': '已切回图形界面的对话。',
  'The Pi TUI cannot open this chat': 'Pi 终端无法打开这个对话',
  'This chat is already open in a terminal in another window':
    '该会话已在另一个窗口的终端中打开，请先关闭那个终端，或在那个窗口里继续。',
  'This chat was saved in an older native format. Open it in the app once to upgrade it, then the Pi terminal can open it.':
    '这个对话保存的是旧版原生格式。先在应用里打开一次完成升级，Pi 终端才能打开它。',
  // T065 回炉 — the other two refusals Main can send. They used to be thrown
  // away by the open path (no terminal, no message), so nothing ever displayed
  // them; now that they reach a toast they need Chinese like the two above.
  'This terminal is already running another chat; close it before opening this one':
    '这个终端已经在运行另一个对话，请先关掉那个终端，再打开这一个。',
  'This chat is still running a turn; wait for it to finish before opening the Pi terminal':
    '这个对话还有一轮没跑完，等它结束之后再打开 Pi 终端。',
  'Preview limit': '预览上限',
  'Review changes with AI assistance': '用 AI 协助审阅改动',
  'Save changes (Cmd+S)': '保存改动（Cmd+S）',
  'Sending…': '正在发送…',
  Service: '服务',
  'Service URL': '服务地址',
  'Shell path (e.g. {{example}})': 'Shell 路径（例如 {{example}}）',
  'Shown in the model picker': '显示在模型选择器里',
  'The selected directory will be stored as a repository bound to this SSH profile.':
    '所选目录会作为绑定到该 SSH 配置的仓库保存。',
  'This address cannot be used. Remove any query string, or credentials in it.':
    '这个地址不能用。请去掉其中的查询串或账号密码。',
  'This directory is not readable or writable. Please choose another location.':
    '该目录不可读写，请换一个位置。',
  'This will terminate all active agent and terminal sessions. You will need to register again to continue using AI features.':
    '这会结束所有正在运行的 agent 与终端会话。要继续使用 AI 功能需要重新注册。',
  'Use an http or https address.': '请使用 http 或 https 地址。',
  'User profile': '用户资料',
  Worktree: '工作树',
  'You have unsaved changes. Discard them?': '有未保存的改动，要放弃吗？',
  '{{count}} models available': '有 {{count}} 个模型可用',

  // H/17 L3/L5 的「AI 服务」面板 —— 整片没有词条，中文界面里从标题到按钮
  // 全是英文（H/21 点验 D4）。`Edit` / `Enabled` / `Remove` 在别处也用，含义
  // 一致，所以做成通用词条而不是面板专属。
  'Services you add yourself. Keys are stored on this machine only.':
    '你自己添加的服务。密钥只存在这台机器上。',
  Configured: '已配置',
  'Add service': '添加服务',
  'No AI services yet': '还没有 AI 服务',
  'Add one to use your own model provider in this app.': '添加一个，就能在本应用里用你自己的模型。',
  '{{count}} models': '{{count}} 个模型',
  'No models selected': '未选择模型',
  // `Edit` / `Enabled` / `Remove` are already in this catalog and mean the
  // same thing there, so this pane needs no entries for them.
  'Unlock the system keyring to see and change your AI services.':
    '解锁系统密钥环后才能查看和修改你的 AI 服务。',
  'The system keyring is unavailable, so keys are stored unencrypted on this machine.':
    '系统密钥环不可用，密钥以明文存在这台机器上。',
  'Stored AI services could not be read. Adding one again will replace the record.':
    '读不到已存的 AI 服务。再添加一次会覆盖原记录。',
  // Not previously in the catalog — a bare English `Done` in a Chinese dialog
  // is the same residue the field report flagged, so it is added here rather
  // than created anew.
  Done: '完成',

  // H/19 U4：用户自装的 pi 扩展。cutover-02 / cutover-03：它们不再进 GUI 会话。
  'npm:package-name, a git URL, or a folder path': 'npm:包名、git 地址，或者一个目录路径',
  'Package source': '包来源',
  'Installing downloads from the network and can take a few seconds.':
    '安装会联网下载，可能要等几秒。',
  'Project-level plugins are ignored on the managed route, so this app installs to your account only.':
    '登录模式下项目级插件不会生效，所以本应用只装到你的账户下。',
  'Extensions installed for your account. Only the built-in Pi terminal loads them; chats in this app do not.':
    '装在你账户下的扩展。只有内嵌的 Pi 终端会加载它们，本应用里的对话不会。',
  'Installed plugins could not be listed:': '读取已装插件失败：',
  'Loading plugins...': '正在读取插件…',
  // 'No plugins installed' and 'Installing...' are already in this file, from
  // the Claude-era plugin browser. Reusing them rather than adding a second
  // spelling — a duplicate key silently wins over the first one.
  'Install one by package name to add tools or commands to your sessions.':
    '按包名装一个，给会话加上工具或命令。',
  'Settings file': '设置文件',
  // cutover-02: the page used to say this app steps aside for a permission
  // system the user installed. Since P6-5 nothing of the sort is loaded in a
  // chat — approval is always ours — and an installed one only reaches the
  // built-in terminal.
  'This app approves tool calls with its own permission system in every chat.':
    '本应用的每个对话，都由它自带的权限系统审批工具调用。',
  'The pi permission system you installed applies to the built-in terminal only, not to chats in this app.':
    '你自己安装的 pi 权限系统只对内嵌终端生效，管不到本应用里的对话。',
  'This app could not read its plugin settings, so it cannot say which permission system the built-in terminal runs.':
    '本应用读不到自己的插件设置，因此无法确定内嵌终端会运行哪一份权限系统。',
  // U13: sidebar group for chats that never got a project folder — they run in
  // a throwaway directory, so they belong to no repository.
  'Temporary chats': '临时对话',
  'Show more': '显示更多',
  'Show less': '收起',
  'Filter sessions': '筛选会话',
  'Expand Recent': '展开最近',
  'Collapse Recent': '收起最近',
  'No matching sessions': '无匹配会话',
  'Settings Display Mode': '设置视图',
  'Switch to floating mode': '切换为浮动模式',
  'Switch to TAB mode': '切换为标签模式',
  Select: '选择',
  'Select Agent': '选择 Agent',
  'Manage Agents': '管理 Agents',
  'Select all': '全选',
  'Select base branch': '请选择基于哪个分支创建',
  'Select branch': '选择分支...',
  'Select a workspace': '选择工作区',
  'Select a Worktree to start using AI coding assistant':
    '选择一个 Worktree 以开始使用 AI 编码助手',
  'Select a folder to start using AI coding assistant': '选择一个文件夹以开始使用 AI 编码助手',
  'Select a Worktree to view changes': '选择一个 Worktree 以查看更改',
  'Select a file to view changes': '选择一个文件以查看更改',
  'Select file to view diff': '从左侧选择文件以查看更改',
  'Send to session': '发送到会话',
  'Sent to session': '已发送到会话',
  Settings: '设置',
  'Settings...': '设置...',
  Shell: 'Shell',
  'Show changed files': '显示更改文件',
  'Show favorites only': '仅显示收藏',
  'Show sidebar': '显示侧边栏',
  'Show in Finder': '在 Finder 中显示',
  'Show in IDE': '在 IDE 中打开',
  'Show in Terminal': '在终端中打开',
  'Show file tree': '显示文件树',
  'Start editing': '开始编辑',
  'Start using AI Agent': '开始使用 AI Agent',
  'Starting shell...': '正在启动终端...',
  'Staged changes': '暂存的更改',
  'Staged changes ({{count}})': '暂存的更改 ({{count}})',
  Staged: '已暂存',
  Stale: '过期',
  Status: '状态',
  'Switch to Agent': '切换到 Agent',
  'Switch to File': '切换到 文件',
  'Switch to list view': '切换到列表视图',
  'Switch to Terminal': '切换到 终端',
  'Switch to Version Control': '切换到 版本管理',
  'Switch to tree view': '切换到树状视图',
  'Switch to previous file': '再按一次切换到上一个文件',
  'Switch to next file': '再按一次切换到下一个文件',
  'Switch to {{name}}': '切换到 {{name}}',
  'Switch repository': '切换仓库',
  'Switch Worktree': '切换 Worktree',
  'Sync terminal theme': '同步终端',
  'Sync completed': '同步完成',
  'Sync failed': '同步失败',
  'Already up to date': '已是最新',
  '{{branch}} is in sync with remote': '{{branch}} 与远程仓库已同步',
  'Fix this error:': '修复此错误:',
  Synced: '已同步',
  Terminal: '终端',
  'Terminal appearance': '自定义终端外观',
  'Terminal renderer and performance settings': '终端渲染与性能设置',
  'Terminal scrollback': '回滚行数',
  'Terminal shortcuts': '设置终端快捷键',
  Theme: '主题',
  'Theme mode': '模式',
  Tree: '树状',
  'Tree view': '树状视图',
  'Try a different search term': '尝试使用不同的关键词搜索',
  'Two-column layout: tree sidebar, workspace': '两栏布局：树状侧边栏、工作区',
  'Unknown error': '未知错误',
  'Unstaged changes': '未暂存的更改',
  'Unstaged changes ({{count}})': '更改 ({{count}})',
  'Untracked changes ({{count}})': '未跟踪的更改 ({{count}})',
  'Untracked files': '未跟踪的文件',
  'Up to date': '已是最新',
  'Update ready': '更新已就绪',
  'Session review': '审阅',
  'Close review': '关闭审阅',
  'Recorded {{count}} changes': '记录了 {{count}} 项改动',
  'Counts include previews; unavailable diffs are excluded.':
    '统计包含历史预览，不包含无法展示的差异。',
  'Load earlier changes': '加载更早的修改记录',
  'Open file': '打开文件',
  'No file changes recorded in this conversation yet.': '当前对话尚无文件修改记录。',
  'Changes recorded by Edit and Write in this conversation. Shell and external edits are not tracked.':
    '记录当前对话中 Edit 和 Write 的修改；不包含命令行及外部编辑。',
  'Diff exceeds the preview limit.': '差异超过预览大小限制。',
  'Binary content has no text diff.': '二进制内容无法展示文本差异。',
  'Previous content could not be read; no diff is available.': '未能读取修改前内容，无法展示差异。',
  'Historical tool diff': '历史工具差异',
  'Historical argument preview — full file diff unavailable':
    '历史修改参数预览，无法还原完整文件差异',
  'No text differences.': '没有文本差异。',
  'No newline at end of file': '文件末尾无换行符',
  'Review file changes from the current conversation in the right panel.':
    '在右侧审阅栏查看当前对话的文件修改。',
  'Show session review': '显示审阅入口',
  'Update failed': '更新失败',
  'The update is downloading. You can continue working.': '正在下载更新，你可以继续工作。',
  'The update could not be completed. You can retry.': '更新未能完成，可以重试。',
  'Download update': '下载更新',
  'Use your system package manager or install a newer package to update.':
    '请通过系统软件包管理器或安装新版软件包更新。',
  'Automatically download and install updates. New version reminders remain enabled when off.':
    '自动下载并安装更新；关闭后仍会提醒发现的新版本。',
  Updates: '更新',
  'Application update settings': '应用更新设置',
  'Auto update': '自动更新',
  'Automatically download and install updates': '自动下载并安装更新',
  Proxy: '代理',
  'Network proxy settings': '网络代理设置',
  'Enable proxy': '启用代理',
  'Route all network requests through proxy': '通过代理路由所有网络请求',
  'Proxy server': '代理服务器',
  'e.g., 127.0.0.1:7897 or http://proxy:8080': '例如 127.0.0.1:7897 或 http://proxy:8080',
  Test: '测试',
  'Testing...': '测试中...',
  Failed: '失败',
  'Bypass list': '绕过列表',
  'Comma-separated list of hosts that bypass the proxy': '不走代理的主机列表，用逗号分隔',
  'Update via proxy': '代理更新',
  'Route update requests through proxy': '通过代理检查和下载应用更新',
  'Requires proxy to be enabled': '需要先启用代理',
  'View diff': '查看差异',
  'View more': '查看更多',
  'Waiting {{seconds}} seconds': '{{seconds}} 秒',
  Workspace: '工作区',
  'Workspace clean': '工作区干净',
  'Workspace is not a Git repository': '当前目录还不是 Git 仓库，初始化后即可使用 Git 功能',
  'Workspace panel shortcuts': '工作区面板快捷键',
  Worktrees: 'Worktree',
  'Worktree created': '创建 Worktree',
  'Worktree delete description prunable': '该目录已被删除，将清理 git 记录。',
  'Worktree delete description destructive': '这将删除目录及其中所有文件，此操作不可撤销！',
  'Worktree delete force hint': '目录包含未提交的修改，请勾选「强制删除」',
  'Worktree deleted': '已删除',
  'Worktree list empty': '创建第一个 Worktree 开始工作',
  'Worktree not found': '未找到匹配',
  'Worktree path already exists. Choose a different path or branch name.':
    '目录已存在，请选择其他路径或分支名',
  'Worktree search placeholder': '搜索 worktree...',
  'Toggle Worktree': '折叠/展开 Worktree',
  'Toggle Repository': '折叠/展开仓库',
  'Tmux Session': 'Tmux 会话',
  'tmux is not installed. Please install tmux first.': 'tmux 未安装，请先安装 tmux。',
  'Yes, remove': '移除',
  'You have {{count}} changed files': '{{count}} 个文件已更改',
  'You have no worktrees yet': '暂无 Worktree',
  'Your workspace is clean': '工作区干净',
  '(optional)': '(可选)',
  'Absolute path': '绝对路径',
  'Additional arguments': '附加参数',
  'Override default command lookup': '覆盖默认的命令查找路径',
  'Extra arguments passed to the agent': '传递给 Agent 的额外参数',
  Add: '添加',
  Added: '新增',
  'Add custom CLI tools': '添加自定义 CLI 工具',
  'Add custom agent': '添加自定义 Agent',
  'Agent sessions': 'Agent Session',
  Appearance: '外观',
  'Base branch': '基于分支',
  'Best compatibility (recommended)': '兼容性最佳，推荐',
  'Bold font weight': '粗体字重',
  Change: '更换',
  Chinese: '中文',
  'Choose sidebar layout mode': '选择侧边栏布局模式',
  'Choose file tree display mode': '选择文件树展示模式',
  Clear: '清除',
  Columns: '三栏',
  'Committing...': '提交中...',
  'Configure available AI Agent CLI tools': '配置可用的 AI Agent CLI 工具',
  Detect: '检测',
  Detached: '分离',
  'Detached HEAD': '分离 HEAD',
  Enable: '启用',
  Enabled: '已启用',
  'Eye-friendly dark theme': '护眼的暗色主题',
  'Follow system theme': '自动适配系统主题',
  'Good compatibility': '兼容性好',
  Later: '稍后',
  'Main tab switching': '主标签切换',
  'No custom agents yet': '暂无自定义 Agent',
  'Remote branches': '远程分支',
  Preview: '预览',
  Save: '保存',
  "Don't Save": '不保存',
  'Save failed': '保存失败',
  'File read failed': '读取文件失败',
  'File changed externally': '文件已被外部修改',
  'Keep Mine': '保留本地',
  Reload: '重新加载',
  'Do you want to save the changes you made to {{file}}?': '要保存对 {{file}} 的更改吗？',
  "Your changes will be lost if you don't save them.": '如果不保存，你的更改将丢失。',
  'Set global main tab shortcuts (Cmd on macOS, Win on Windows)':
    '设置全局主标签切换快捷键 (macOS 上是 Cmd,Windows 上是 Win 键)',
  'Short description': '简短描述',
  View: '视图',
  'Zoom In': '放大',
  'Zoom Out': '缩小',
  'Reset Zoom': '重置缩放',
  Window: '窗口',
  '(default)': '(默认)',
  '{{command}} completed': '{{command}} 已完成',
  '{{count}} lines': '{{count}} 行',
  '{{count}} seconds': '{{count}} 秒',
  '{{count}} minutes ago': '{{count}} 分钟前',
  '{{count}} hours ago': '{{count}} 小时前',
  '{{count}} days ago': '{{count}} 天前',
  '{{count}} months ago': '{{count}} 个月前',
  '{{count}} years ago': '{{count}} 年前',
  '{{count}} staged changes': '{{count}} 个已暂存的更改',
  '{{count}} repositories in this group will be moved to ungrouped.':
    '该分组中的 {{count}} 个仓库将被移至未分组。',
  '{{count}} commits ahead': '领先 {{count}} 个提交',
  '{{count}} commits behind': '落后 {{count}} 个提交',
  '(staged)': '(已暂存)',
  '(unstaged)': '(未暂存)',
  Active: '活跃',
  'Active sessions': '活跃会话',
  'Add a Git repository from a local folder to get started': '从本地文件夹添加 Git 仓库开始使用',
  'Higher performance, may have issues': '性能更高，可能有兼容问题',
  'Bright theme': '明亮的界面主题',
  'Choose display language': '选择界面语言',
  'Choose interface theme': '选择界面的深浅模式',
  'Clean up records': '清理记录',
  'Click the button in the top right to create your first worktree':
    '点击右上角按钮创建第一个 Worktree',
  'Close Agent Sessions': '关闭 Agent 会话',
  'Close All Agent Sessions': '关闭所有 Agent',
  'Close All Sessions': '关闭所有会话',
  'Close All Terminal Sessions': '关闭所有终端',
  'Close Terminal Sessions': '关闭终端会话',
  'Confirm close all agent sessions?': '确认关闭所有 Agent 会话？',
  'Confirm close all terminal sessions?': '确认关闭所有终端会话？',
  'Confirm exit': '确认退出',
  // T065 — closing one of several windows is not the app exiting; the old copy
  // asked about quitting either way.
  'Close this window': '关闭这个窗口',
  'The app keeps running in your other windows.': '应用会在你其他的窗口里继续运行。',
  'Close window': '关闭窗口',
  'Create your first worktree to get started': '创建第一个 Worktree 开始工作',
  'Creating...': '创建中...',
  Dark: '深色',
  'Draggable Modal Window': '可拖动模态窗口',
  'Delete failed': '删除失败',
  'Deleting...': '删除中...',
  'Describe your changes...': '描述你的更改...',
  'Diff navigation shortcuts': '设置 Diff 导航快捷键',
  Exit: '退出',
  'Experimental features': '实验性功能',
  'Generate with AI': 'AI 生成',
  'Generating...': '生成中...',
  'History lines in the terminal. Higher values use more memory.':
    '终端可向上滚动查看的历史行数，值越大内存占用越高',
  'Initialize repository': '初始化仓库',
  'Just now': '刚刚',
  'Learn More': '了解更多',
  'Loading {{agent}}...': '正在启动 {{agent}}...',
  'Match terminal color scheme': '跟随终端配色方案',
  'New Window': '新建窗口',
  'New version': '新版',
  'New version available': '发现新版本',
  'Next change': '下一处差异',
  'Next change (F8, press again to switch file)': '下一处差异 (F8, 再按切换文件)',
  'Next Session': '下一个会话',
  'Next Tab': '下一个标签',
  'Not a Git repository': '不是 Git 仓库',
  'Open in Terminal': '在终端中打开',
  'Press a shortcut...': '按下快捷键...',
  'Previous change': '上一处差异',
  'Previous change (F7, press again to switch file)': '上一处差异 (F7, 再按切换文件)',
  'Previous Session': '上一个会话',
  'Previous Tab': '上一个标签',
  Pull: '拉取',
  Pulled: '已拉取',
  'Pull successful': '拉取成功',
  'Pull failed': '拉取失败',
  'Pulled {{count}} commits from remote': '从远程拉取了 {{count}} 个提交',
  'Pulled {{count}} commit(s) on {{branch}}': '在 {{branch}} 上拉取了 {{count}} 个提交',
  'Pushed {{count}} commit(s) on {{branch}}': '在 {{branch}} 上推送了 {{count}} 个提交',
  'Pulled {{pulled}} commit(s), pushed {{pushed}} commit(s) on {{branch}}':
    '在 {{branch}} 上拉取了 {{pulled}} 个提交，推送了 {{pushed}} 个提交',
  Push: '推送',
  Pushed: '已推送',
  Recent: '最近',
  'Recent commits': '最近提交',
  'Restart now': '立即重启',
  'Save location': '保存位置',
  'Search themes...': '搜索主题...',
  Search: '搜索',
  'File search shortcuts': '文件搜索快捷键',
  'Search files': '搜索文件',
  'Search content': '搜索内容',
  'Editor shortcuts': '编辑器快捷键',
  'Show Symbols': '显示符号列表',
  'Select file': '选择文件',
  'Select files': '选择文件',
  'Select folder': '选择文件夹',
  'Select a file from the file tree to begin editing': '从左侧文件树中选择文件以开始编辑',
  'Skipped {{dirs}} (not in .gitignore)': '已跳过 {{dirs}}（未添加到 .gitignore）',
  'Sync with remote': '同步远程',
  '(commit history)': '(提交历史)',
  'Open in editor': '在编辑器中打开',
  'Collapse unchanged code': '折叠未修改代码',
  'Show unchanged code': '显示未修改代码',
  'Discard {{count}} changes': '撤销 {{count}} 处更改',
  'Delete {{count}} files': '删除 {{count}} 个文件',
  'Are you sure you want to discard changes to {{count}} files? This cannot be undone.':
    '确定要撤销 {{count}} 个文件的更改吗？此操作不可恢复。',
  'Are you sure you want to delete {{count}} untracked files? This cannot be undone.':
    '确定要删除 {{count}} 个未跟踪的文件吗？此操作不可撤销。',
  'Are you sure you want to delete the untracked file {{path}}? This cannot be undone.':
    '确定要删除未跟踪的文件 {{path}} 吗？此操作不可撤销。',
  Stage: '暂存',
  'Stage all': '全部暂存',
  'Stage changes before committing': '暂存更改后才能提交',
  System: '跟随系统',
  'Three-column layout: repos, worktrees, workspace': '三栏布局：仓库、worktree、工作区',
  'OpenChamber Workspace Shell': 'OpenChamber 工作区外壳',
  'Three-column chat workspace with icon rail and context surfaces':
    '三列气泡对话工作区：图标导轨 + 上下文面板。关闭后立即回到旧版标签页界面。',
  'File Tree Display': '文件树展示',
  'Integrated tree': '集成模式',
  'Tree + editor in one panel': '文件树与编辑器在同一面板',
  'Split sidebar': '分栏模式',
  'Dedicated file sidebar + editor': '独立文件侧栏 + 编辑器',
  'Repository List Display': '仓库列表展示',
  'Choose how repositories and submodules are displayed in source control':
    '选择版本管理中仓库和子模块的展示方式',
  // 这条同时服务左侧面板的 Plan/List 类标签和工具行的动词态，统一成动词。
  List: '列出',
  'VSCode-style collapsible list': 'VSCode 风格可折叠列表',
  Tabs: '标签页',
  'Horizontal tabs for quick switching': '水平标签页，快速切换',
  'Integrated tree + editor (original)': '树与编辑器一体（原有）',
  Original: '原有',
  'Split sidebar + editor (current)': '文件侧栏与编辑器分离（当前）',
  'This branch will be created and checked out in the new worktree.':
    '将创建此分支并在新 worktree 中检出',
  'This directory has already been removed; Git records will be cleaned up.':
    '该目录已被删除，将清理 git 记录。',
  'This directory contains uncommitted changes. Please check "Force delete".':
    '目录包含未提交的修改，请勾选「强制删除」',
  'This directory is not a Git repository. Initialize it to enable Git features.':
    '当前目录还不是 Git 仓库，初始化后即可使用 Git 功能',
  'This does not affect CLI logins in your system terminal.': '不影响系统终端里的 CLI 登录',
  'This will delete the directory and all files inside. This action cannot be undone!':
    '这将删除目录及其中所有文件，此操作不可撤销！',
  'This will only remove it from the app and will not delete local files.':
    '此操作只会从应用中移除，不会删除本地文件。',
  'Unable to determine your home directory': '无法获取用户目录',
  Unstage: '取消暂存',
  'Unstage all': '全部取消暂存',
  Version: '版本',
  'Version Control': '版本管理',
  'Version {{version}} has been downloaded. Restart now to install?':
    '新版本 {{version}} 已下载完成，是否立即重启安装？',
  'Version {{version}} is available. Please download it manually.':
    '新版本 {{version}} 已发布，请前往下载页面手动更新。',
  'Version {{version}} is available. Do you want to download and update now?':
    '检测到新版本 {{version}}，是否立即下载并更新？',
  'Update now': '立即更新',
  中文: '中文',
  // Editor settings
  Editor: '编辑器',
  'Configure code editor appearance for file viewer and diff viewer':
    '配置文件查看器和差异查看器的编辑器外观',
  // Font section
  'Editor font settings': '编辑器字体设置',
  'Font family': '字体',
  'Line height': '行高',
  'Font ligatures': '字体连字',
  'Enable font ligatures': '启用字体连字',
  // Spacing section
  Spacing: '间距',
  'Editor padding settings': '编辑器内边距设置',
  'Padding top': '顶部内边距',
  'Padding bottom': '底部内边距',
  // Indentation section
  Indentation: '缩进',
  Init: '初始化',
  'Tab and space settings': 'Tab 与空格设置',
  'Tab size': 'Tab 宽度',
  'Tab (Integrated)': 'Tab 标签页',
  'Insert spaces': '使用空格',
  'Use spaces instead of tabs': '使用空格代替 Tab',
  // Display section
  Display: '显示',
  'Editor display settings': '编辑器显示设置',
  Minimap: '迷你地图',
  'Show minimap in editor': '在编辑器中显示迷你地图',
  'Line numbers': '行号',
  On: '显示',
  Off: '关闭',
  Relative: '相对',
  'Word wrap': '自动换行',
  'Word wrap column': '按列换行',
  Bounded: '边界换行',
  Whitespace: '空白字符',
  None: '不显示',
  Boundary: '边界',
  Selection: '选中',
  Trailing: '行尾',
  'Line highlight': '行高亮',
  Gutter: '边栏',
  Line: '行',
  'Code folding': '代码折叠',
  'Enable code folding': '启用代码折叠',
  'Clickable links': '可点击链接',
  'Make links clickable': '使链接可点击',
  'Smooth scrolling': '平滑滚动',
  'Enable smooth scrolling': '启用平滑滚动',
  'Git Blame': 'Git Blame',
  'Show inline git blame info at cursor line': '在光标行显示内联 Git Blame 信息',
  // Cursor section
  Cursor: '光标',
  'Cursor appearance settings': '光标外观设置',
  'Cursor style': '光标样式',
  'Line thin': '细线',
  Block: '块状',
  'Block outline': '块状轮廓',
  Underline: '下划线',
  'Underline thin': '细下划线',
  'Cursor blinking': '光标闪烁',
  Blink: '闪烁',
  Smooth: '平滑',
  Phase: '渐变',
  Expand: '展开',
  Solid: '静止',
  // Brackets section
  Brackets: '括号',
  'Bracket matching and guides': '括号匹配与引导线',
  'Rainbow brackets': '彩虹括号',
  'Colorize matching bracket pairs': '为匹配的括号对着色',
  'Match brackets': '匹配括号',
  Always: '始终',
  Near: '靠近时',
  Never: '从不',
  'Bracket guides': '括号引导线',
  'Show bracket pair guides': '显示括号配对引导线',
  'Indent guides': '缩进引导线',
  'Show indentation guides': '显示缩进引导线',
  // Editing section
  Editing: '编辑',
  'Auto-create session': '自动创建会话',
  'Automatically create Agent/Terminal session when activating a worktree':
    '激活 Worktree 时自动创建 Agent / 终端会话',
  'Quick Terminal': '快捷终端',
  'Enable Quick Terminal': '启用快捷终端',
  'Show floating terminal button for quick access': '显示浮动终端按钮以便快速访问',
  'Hide Groups': '隐藏分组',
  'Hide group management panel and show all repositories': '隐藏分组管理面板，显示所有仓库',
  'Quick Open': '快捷打开',
  'Configure apps shown in the quick open menu': '配置快捷打开菜单中显示的应用',
  'File Manager': '文件管理器',
  Terminals: '终端',
  Editors: '编辑器',
  'Enable filtering to configure which apps are shown': '开启筛选后可配置显示的应用',
  'Hide Repository': '隐藏仓库',
  'Hidden repositories will not appear in the sidebar': '隐藏的仓库不会显示在侧边栏中',
  'Show Repository': '显示仓库',
  'Manage Repositories': '管理仓库',
  '{{total}} repositories, {{hidden}} hidden': '共 {{total}} 个仓库，{{hidden}} 个已隐藏',
  'Tip: Use the list button in the top-left corner to manage hidden repositories':
    '提示：点击左上角的列表按钮可管理隐藏的仓库',
  'Auto-completion settings': '自动补全设置',
  'Auto brackets': '自动括号',
  'Auto quotes': '自动引号',
  'Language defined': '跟随语言',
  'Before whitespace': '空白字符前',
  Confirm: '确定',
  Submit: '提交',
  'Image too large': '图片过大',
  'Max image size is {{size}}MB': '单张图片最大 {{size}}MB',
  'Too many images': '图片数量过多',
  'Max images is {{count}}': '最多只能选择 {{count}} 张图片',
  'Failed to save image': '保存图片失败',
  'Type your message... (Shift+Enter for newline)': '输入消息... (Shift+Enter 换行)',
  'Drag and drop images or paste from clipboard': '拖放图片或从剪贴板粘贴',
  Send: '发送',
  lines: '行',
  // Commit Message Generator
  'Commit Message Generator': '生成 Commit Message',
  'Enable Generator': '启用生成器',
  'Generate commit messages with AI assistance': '使用 AI 辅助生成 commit 消息',
  'Max Diff Lines': '最大 Diff 行数',
  'Maximum number of diff lines to include': '包含的最大 diff 行数',
  Timeout: '超时',
  'Timeout in seconds': '超时时间（秒）',
  Model: '模型',
  seconds: '秒',
  'Generate commit message': '生成 commit 消息',
  'Failed to generate commit message': '生成 commit 消息失败',
  'Generation timed out': '生成超时',
  // Code Review
  'Code Review': '代码审查',
  'AI-powered code review for staged changes': 'AI 驱动的代码审查',
  // AI Settings
  AI: 'AI',
  'AI Features': 'AI 功能',
  'Configure AI-powered features for code generation and review':
    '配置 AI 功能，包括代码生成和审查',
  Provider: '服务提供商',
  'AI provider to use': '使用的 AI 服务提供商',
  'Auto-generate commit messages using AI': '使用 AI 自动生成提交信息',
  'Model for generating commit messages': '生成提交信息使用的模型',
  'Model for code review': '代码审查使用的模型',
  'Custom model': '自定义模型',
  'Enter model id (e.g. gpt-5.4)': '输入模型 ID（例如 gpt-5.4）',
  'Auto-generate branch names using AI': '使用 AI 自动生成分支名',
  'Model for generating branch names': '生成分支名使用的模型',
  'Reasoning Level': '推理深度',
  'Enable Code Review': '启用代码审查',
  'Show code review button in source control': '在版本控制中显示代码审查按钮',
  'Language for code review output': '代码审查输出语言',
  'Code Review Prompt': '代码审查提示词',
  'Customize the AI prompt for code review': '自定义代码审查的 AI 提示词',
  'This will restore the default AI prompt for code review. Your custom prompt will be lost.':
    '这将恢复代码审查的默认 AI 提示词。您的自定义提示词将丢失。',
  'Enter a prompt template for code review.\nAvailable variables:\n• {language} - Review output language\n• {git_diff} - Git diff of changes\n• {git_log} - Commit history':
    '输入代码审查的提示词模板。\n可用变量：\n• {language} - 审查输出语言\n• {git_diff} - 变更的 Git diff\n• {git_log} - 提交历史',
  'Continue Conversation': '继续对话',
  'Preserve session for follow-up conversations after review': '审查后保留 session 以便继续对话',
  Review: '审查',
  'Reviewing...': '审查中...',
  'View code review': '查看代码审查',
  Minimize: '最小化',
  'Missing required variable: {git_diff}': '缺少必需变量：{git_diff}',
  'Missing recommended variable: {language}': '缺少推荐变量：{language}',
  'Missing recommended variable: {git_log}': '缺少推荐变量：{git_log}',
  'Start code review': '开始代码审查',
  'Initializing...': '初始化中...',
  'Reviewing code...': '正在审查代码...',
  'Review complete': '审查完成',
  'Review failed': '审查失败',
  'Starting code review...': '正在启动代码审查...',
  'Review may take a while. You can minimize this window and continue other work — results will be here when done.':
    '审查可能需要一段时间。你可以最小化此窗口继续其他工作，完成后回来查看结果。',
  'AI Review': 'AI 审查',
  'Ready to start AI code review': '准备启动 AI 代码审查',
  'Another repository is being reviewed': '另一个仓库正在审查中',
  'Wait for the running review to finish, or switch to that repository to manage it.':
    '请等待当前审查结束，或切换到该仓库进行操作。',
  'Click Start to analyze your changes. This will consume API credits.':
    '点击"开始审查"分析你的改动，此操作会消耗 API 额度。',
  'Review content copied to clipboard': '审查内容已复制到剪贴板',
  'Commit ID copied to clipboard': 'Commit ID 已复制到剪贴板',
  'Copy failed': '复制失败',
  'Failed to copy content': '复制内容失败',
  'Re-review': '重新审查',
  'Review in progress. Are you sure you want to restart?': '审查进行中，确定要重新开始吗？',
  'Confirm Restart': '确认重新开始',
  Restart: '重新开始',
  Restore: '还原',
  Maximize: '最大化',
  'Branch Name Generator': '分支名称生成器',
  // 'Enable Generator': '启用生成器',
  'Generate branch names with AI assistance': '使用 AI 辅助生成分支名称',
  Prompt: '提示词',
  'Customize the AI prompt for generating branch names': '自定义生成分支名称的 AI 提示词',
  'Enter a prompt template, and the AI will generate branch names according to your rules.\nAvailable variables:\n• {description} - Feature description\n• {current_date} - Current date\n• {current_time} - Current time':
    '输入提示词模板，AI 将根据您的规则生成分支名称。\n可用变量：\n• ⁠{description} - 功能描述\n• ⁠{current_date} - 当前日期\n• ⁠{current_time} - 当前时间',
  'Generate branch name': '生成分支名称',
  'Failed to generate branch name': '生成分支名称失败',
  'Generating branch name...': '正在生成分支名称...',
  'Restore Default': '恢复默认',
  'Restore default prompt': '恢复默认提示词',
  'This will restore the default AI prompt for generating branch names. Your custom prompt will be lost.':
    '这将恢复生成分支名称的默认 AI 提示词。您的自定义提示词将丢失。',
  // Commit Prompt section
  'Commit Prompt': '提交提示词',
  'Customize the AI prompt for generating commit messages': '自定义生成提交信息的 AI 提示词',
  'Enter a prompt template for generating commit messages.\nAvailable variables:\n• {recent_commits} - Recent commit messages\n• {staged_stat} - Staged changes statistics\n• {staged_diff} - Staged changes diff':
    '输入提示词模板，AI 将根据您的规则生成提交信息。\n可用变量：\n• {recent_commits} - 最近的提交信息\n• {staged_stat} - 暂存区变更统计\n• {staged_diff} - 暂存区变更详情',
  'This will restore the default AI prompt for generating commit messages. Your custom prompt will be lost.':
    '这将恢复生成提交信息的默认 AI 提示词。您的自定义提示词将丢失。',
  // Auto Save section
  'Auto Save': '自动保存',
  'Auto save settings': '自动保存设置',
  'Auto save': '自动保存',
  'After delay': '延迟后',
  'On focus change': '失去焦点时',
  'On window change': '窗口失焦时',
  'Auto save is disabled': '关闭自动保存',
  'Auto save after a short delay': '短暂延迟后自动保存',
  'Auto save when editor loses focus': '编辑器失去焦点时自动保存',
  'Auto save when window loses focus': '窗口失去焦点时自动保存',
  Delay: '延迟',
  ms: '毫秒',
  // Merge Worktree
  'Merge to Branch...': '合并到分支...',
  'Merge Worktree': '合并 Worktree',
  'Merge branch "{{branch}}" into another branch': '将分支 "{{branch}}" 合并到其他分支',
  'Target branch': '目标分支',
  'Choose target branch...': '选择目标分支...',
  'The branch to merge your changes into': '你的更改将被合并到该分支',
  'Merge strategy': '合并策略',
  Merge: '合并',
  'Create a merge commit (--no-ff)': '创建合并提交 (--no-ff)',
  Squash: '压缩',
  'Squash all commits into one': '将所有提交压缩为一个',
  Rebase: '变基',
  'Rebase commits onto target branch': '将提交变基到目标分支',
  'After merge': '合并后',
  'Delete worktree': '删除 worktree',
  'Delete branch': '删除分支',
  'Included with worktree deletion': '包含在 worktree 删除中',
  'Please select a target branch': '请选择目标分支',
  'Cannot merge a branch into itself': '不能将分支合并到自身',
  'Merge failed': '合并失败',
  'Merging...': '合并中...',
  // Merge Conflict Editor
  'Resolve Conflicts': '解决冲突',
  'Abort Merge': '中止合并',
  'Complete Merge': '完成合并',
  'Commit message...': '提交信息...',
  'Previous conflict': '上一个冲突',
  'Next conflict': '下一个冲突',
  'Accept All Theirs': '接受全部对方更改',
  'Accept All Ours': '接受全部我方更改',
  Accept: '接受',
  'Saving...': '保存中...',
  Resolved: '已解决',
  'Mark Resolved': '标记为已解决',
  resolved: '已解决',
  // Merge error messages
  'Worktree has uncommitted changes. Please commit or stash them first.':
    'Worktree 有未提交的更改，请先提交或暂存',
  'Main worktree has uncommitted changes. Please commit or stash them first.':
    '主 worktree 有未提交的更改，请先提交或暂存',
  'There are still unresolved conflicts': '仍有未解决的冲突',
  'Merge completed with warnings': '合并完成但有警告',
  'Stash pop had conflicts. Please resolve manually.': '恢复暂存时发生冲突，请手动解决',
  'Stash pop conflict in main worktree: {{path}}': '主工作区恢复暂存时发生冲突: {{path}}',
  'Stash pop conflict in worktree: {{path}}': '工作区恢复暂存时发生冲突: {{path}}',
  'Worktree stash pending - resolve main conflict first, then run "git stash pop" in: {{path}}':
    '工作区暂存待恢复 - 请先解决主工作区冲突，然后在以下目录运行 "git stash pop": {{path}}',
  'Changes were automatically stashed and restored after merge': '更改已自动暂存并在合并后恢复',
  'Your uncommitted changes were stashed. After resolving conflicts, run "git stash pop" to restore them.':
    '您未提交的更改已被暂存。解决冲突后，请运行 "git stash pop" 恢复更改。',
  'Main worktree changes were stashed': '主工作区的更改已被暂存',
  'Worktree changes were stashed': '工作区的更改已被暂存',
  'Auto stash uncommitted changes': '自动暂存未提交的更改',
  'Automatically stash and restore uncommitted changes': '合并前自动暂存更改，完成后自动恢复',
  'Changes stashed': '更改已暂存',
  'Your uncommitted changes were stashed. After resolving conflicts, run "git stash pop" in:':
    '您未提交的更改已被暂存。解决冲突后，请在以下目录运行 "git stash pop":',
  // Global Search
  'Search file name...': '搜索文件名...',
  'Search in files...': '在文件中搜索...',
  'Match case': '区分大小写',
  'Match whole word': '全词匹配',
  'Use regular expression': '使用正则表达式',
  Content: '内容',
  '{{count}} matches in {{files}} files': '{{files}} 个文件中有 {{count}} 处匹配',
  '{{count}} files': '{{count}} 个文件',
  'For better performance, install': '为获得更好的性能，请安装',
  Navigate: '导航',
  Open: '打开',
  'File mask': '文件过滤',
  'No results': '无结果',
  'No files found': '未找到文件',
  'Type to search files': '输入以搜索文件',
  'No matches found': '未找到匹配',
  'Type to search in files': '输入以搜索文件内容',
  'No preview available': '无法预览',
  'This file type is not supported for preview': '此文件类型暂不支持预览',
  'Select a result to preview': '选择结果以预览',
  'Unable to load file': '无法加载文件',
  'Use .gitignore': '使用 .gitignore',
  // Remote Connection
  'Remote Connection': '远程连接',
  'Save SSH profiles here, then use the Remote Host entry in the sidebar to attach remote repositories into this window.':
    '在这里保存 SSH 配置，然后通过侧边栏中的“远程主机”入口把远程仓库挂到当前窗口。',
  'SSH Profiles': 'SSH 配置',
  'These profiles reuse your existing SSH configuration and credentials.':
    '这些配置会复用你现有的 SSH 配置和凭据。',
  Profile: '配置',
  'Unknown profile': '未知配置',
  'Create new profile': '新建配置',
  'No profiles saved yet.': '还没有保存任何配置。',
  '{{count}} saved profiles': '已保存 {{count}} 个配置',
  'Profile name': '配置名称',
  'My staging server': '我的测试服务器',
  'SSH target': 'SSH 目标',
  'Use the same target string you would pass to the ssh command.':
    '填写与 ssh 命令相同的目标字符串。',
  'Helper install directory': '助手安装目录',
  'Runtime install directory': '运行时安装目录',
  'Optional override, for example ~/.pilab/remote-helper':
    '可选覆盖目录，例如 ~/.pilab/remote-helper',
  'Optional override, for example ~/.pilab/remote-runtime':
    '可选覆盖目录，例如 ~/.pilab/remote-runtime',
  'Remote Helper': '远程助手',
  'Managed Remote Runtime': '托管远程运行时',
  'Install, refresh, update, or remove the helper on the selected remote host.':
    '在选中的远程主机上安装、刷新、更新或删除助手。',
  'Install, refresh, update, or remove the managed runtime on the selected remote host.':
    '在选中的远程主机上安装、刷新、更新或删除托管运行时。',
  'Select a profile': '选择一个配置',
  'Choose a saved SSH profile above before managing the remote helper.':
    '请先在上方选择一个已保存的 SSH 配置，再管理远程助手。',
  'Choose a saved SSH profile above before managing the remote runtime.':
    '请先在上方选择一个已保存的 SSH 配置，再管理远程运行时。',
  'Helper status': '助手状态',
  'Runtime status': '运行时状态',
  'Current version': '当前版本',
  'Install directory': '安装目录',
  'Installed versions': '已安装版本',
  Connection: '连接状态',
  Connected: '已连接',
  Disconnected: '未连接',
  Verification: '校验状态',
  Verified: '已验证',
  'Verification pending': '校验中',
  'Verification failed': '校验失败',
  'Summary only': '摘要状态',
  'Runtime verification': '运行时校验',
  'Refresh status': '刷新状态',
  Update: '更新',
  'Delete helper': '删除助手',
  'Delete runtime': '删除运行时',
  'Delete remote helper?': '删除远程助手？',
  'Delete managed remote runtime?': '删除托管远程运行时？',
  'This will remove all installed helper versions for this SSH profile.':
    '这会删除该 SSH 配置下安装的所有助手版本。',
  'This will remove all installed managed runtime versions for this SSH profile.':
    '这会删除该 SSH 配置下安装的所有托管运行时版本。',
  'Failed to refresh helper status': '刷新助手状态失败',
  'Failed to refresh runtime status': '刷新运行时状态失败',
  'Failed to install helper': '安装助手失败',
  'Failed to install runtime': '安装运行时失败',
  'Failed to update helper': '更新助手失败',
  'Failed to update runtime': '更新运行时失败',
  'Failed to delete helper': '删除助手失败',
  'Failed to delete runtime': '删除运行时失败',
  'Helper installed': '助手已安装',
  'Runtime installed': '运行时已安装',
  'The current remote helper version is now installed.': '当前远程助手版本已安装。',
  'The managed remote runtime is now installed on this host.': '托管远程运行时现已安装到该主机。',
  'Helper updated': '助手已更新',
  'Runtime updated': '运行时已更新',
  'The current remote helper version was reinstalled successfully.':
    '当前远程助手版本已成功重新安装。',
  'The managed remote runtime was reinstalled successfully.': '托管远程运行时已成功重新安装。',
  'Remote connections currently support Linux x64 and arm64 glibc hosts only.':
    '远程连接目前仅支持 Linux x64 和 arm64 的 glibc 主机。',
  'Helper deleted': '助手已删除',
  'Runtime deleted': '运行时已删除',
  'All installed helper versions for this profile were removed.':
    '该配置下所有已安装的助手版本都已删除。',
  'All installed managed runtime versions for this profile were removed.':
    '该配置下所有已安装的托管运行时版本都已删除。',
  'Save profile': '保存配置',
  'Test connection': '测试连接',
  'Delete profile': '删除配置',
  'Remote environment': '远程环境',
  Platform: '平台',
  'Home directory': '主目录',
  'Failed to load remote profiles': '加载远程配置失败',
  'Profile name is required': '配置名称不能为空',
  'Give this connection a short recognizable name.': '给这个连接起一个简短且容易识别的名字。',
  'SSH target is required': 'SSH 目标不能为空',
  'Use the same target you would pass to ssh, for example user@example.com.':
    '填写与 ssh 命令相同的目标，例如 user@example.com。',
  'Remote profile saved': '远程配置已保存',
  'You can now use it from the Remote Host entry in the sidebar.':
    '现在可以从侧边栏中的“远程主机”入口打开它。',
  'Failed to save remote profile': '保存远程配置失败',
  'Remote profile deleted': '远程配置已删除',
  'The saved SSH connection has been removed.': '已删除保存的 SSH 连接配置。',
  'Failed to delete remote profile': '删除远程配置失败',
  'Profile is incomplete': '配置不完整',
  'Fill in the profile name and SSH target before testing the connection.':
    '请先填写配置名称和 SSH 目标，再测试连接。',
  'Connection succeeded': '连接成功',
  'The remote host is reachable and ready for AiClient remote helper setup.':
    '远程主机可访问，已可继续安装 AiClient 远程助手。',
  'The remote host is reachable and ready for managed runtime setup.':
    '远程主机可访问，已可继续安装托管远程运行时。',
  'Connection failed': '连接失败',
  'SSH password required': '需要 SSH 密码',
  'SSH key passphrase required': '需要 SSH 密钥口令',
  'SSH verification required': '需要 SSH 验证',
  'Verify remote host': '验证远程主机',
  Password: '密码',
  Passphrase: '口令',
  Response: '响应',
  Continue: '继续',
  'Trust host': '信任主机',
  'SSH authentication was cancelled': 'SSH 认证已取消',
  'Enter the SSH credential to continue connecting to {{target}}.':
    '请输入 SSH 凭据以继续连接到 {{target}}。',
  'The remote host is not in your trusted list yet. Verify the fingerprint before continuing.':
    '该远程主机尚未加入受信任列表。请先核对指纹后再继续。',
  'No window available for SSH authentication prompt': '当前没有可用窗口来显示 SSH 认证提示',
  'Failed to resolve SSH configuration': '解析 SSH 配置失败',
  'Failed to resolve SSH target for {{connectionId}}': '无法解析连接 {{connectionId}} 的 SSH 目标',
  'Failed to scan remote host fingerprint': '获取远程主机指纹失败',
  'Failed to parse remote host fingerprint': '解析远程主机指纹失败',
  'Failed to parse remote host fingerprint from SSH handshake': '无法从 SSH 握手中解析远程主机指纹',
  'Failed to verify remote host with SSH handshake': '通过 SSH 握手验证远程主机失败',
  'SSH handshake ended before host verification': 'SSH 握手在主机验证完成前就结束了',
  'SSH handshake timed out before host verification': 'SSH 握手在主机验证完成前超时',
  'Add a local Git repository, clone from a remote URL, or attach a remote repository over SSH.':
    '添加本地 Git 仓库、从远程 URL 克隆，或通过 SSH 把远程仓库挂到当前窗口。',
  'Failed to browse remote roots': '读取远程根目录失败',
  'Failed to browse remote host directories': '读取远程主机目录失败',
  'Please choose an SSH profile first': '请先选择一个 SSH 配置',
  'Please enter the remote repository path': '请输入远程仓库路径',
  'Failed to connect to remote host': '连接远程主机失败',
  'Remote Host': '远程主机',
  'Add Project': '添加项目',
  'Switch Host': '切换主机',
  Disconnect: '断开连接',
  'Disconnect Remote Host': '断开远程主机',
  'Connect to Remote Host': '连接远程主机',
  'This window already has repositories attached from the current remote host.':
    '当前窗口已经挂载了这个远程主机上的仓库。',
  'This window is already attached to the selected remote host.':
    '这个窗口已经连接到选中的远程主机。',
  'Connect to a remote host over SSH, then attach one or more repositories from that host into this window.':
    '先通过 SSH 连接远程主机，再把该主机上的一个或多个仓库挂到当前窗口。',
  'Connecting will prepare this host for attaching repositories into the current window.':
    '连接会为当前窗口挂载该主机上的仓库做好准备。',
  'After connecting, choose repositories from that host to attach into this window.':
    '连接完成后，选择该主机上的仓库挂到当前窗口。',
  'Add a project folder from the current remote host into this window.':
    '把当前远程主机上的仓库目录挂到这个窗口。',
  'Add a project folder from the current remote host to get started.':
    '先把当前远程主机上的仓库目录挂到这个窗口。',
  'Choose a project folder on the current remote host.': '选择当前远程主机上的仓库目录。',
  'Current location': '当前位置',
  'No folder selected': '尚未选择文件夹',
  'Go to parent folder': '返回上级文件夹',
  'Loading folders...': '正在加载文件夹...',
  'This folder has no subfolders': '这个文件夹没有子文件夹',
  'Choose a root folder to start browsing': '先选择一个根目录再开始浏览',
  'The selected folder will be added as a remote project in this window.':
    '选中的目录会作为仓库添加到当前窗口中。',
  'Please choose a remote folder': '请选择仓库目录',
  'Please choose a project directory on this host': '请选择仓库目录',
  'Remote host': '远程主机',
  'Remote folder': '仓库目录',
  'Project directory on this host': '仓库目录',
  'Open in': '打开到',
  'SSH profile': 'SSH 配置',
  'Loading profiles...': '正在加载配置...',
  'Select a saved SSH profile': '选择已保存的 SSH 配置',
  'No saved profiles': '没有已保存的 SSH 配置',
  'Create SSH profiles in Settings > Remote Connection first.':
    '请先到“设置 > 远程连接”中创建 SSH 配置。',
  'Create SSH profiles in Settings > Remote Connection first, then use the Remote Host entry to connect.':
    '请先到“设置 > 远程连接”中创建 SSH 配置，然后通过“远程主机”入口连接。',
  'The same SSH credentials and config you already use will be reused here.':
    '这里会复用你当前已经在用的 SSH 凭据和配置。',
  'Bind this repository to a specific SSH connection.': '把这个仓库绑定到一个指定的 SSH 连接。',
  'Remote repository path': '远程仓库路径',
  'Remote path': '远程路径',
  '/srv/project or ~/workspace/project': '/srv/project 或 ~/workspace/project',
  'Resolving remote roots...': '正在解析远程根目录...',
  'Resolving directories on this host...': '正在解析目录...',
  'Pick a root below or type the full repository path on the remote host.':
    '可先选择下方根目录，或直接输入远程主机上的完整仓库路径。',
  'Choose a project directory on the current remote host.': '选择当前窗口中的仓库目录。',
  'The selected directory will be added as a project from this remote host in the current window.':
    '选中的目录会作为仓库添加到当前窗口中。',
  'Choose the repository directory on the selected SSH host.': '选择所选 SSH 主机上的仓库目录。',
  'Choose a project directory on the selected SSH host.': '选择所选 SSH 主机上的仓库目录。',
  SSH: 'SSH',
  Node: 'Node',
  Connect: '连接',
  'Failed to test remote connection': '测试远程连接失败',
  'Failed to resolve remote home directory': '获取远程主目录失败',
  'Remote helper bootstrap timed out': '远程助手启动校验超时',
  'Remote server bootstrap timed out': '远程服务启动校验超时',
  'Remote helper exited ({{reason}})': '远程助手已退出（{{reason}}）',
  'Remote server exited ({{reason}})': '远程服务已退出（{{reason}}）',
  'Remote helper disconnected': '远程助手连接已断开',
  'Remote server disconnected': '远程服务连接已断开',
  'Failed to establish remote helper for {{connectionId}}':
    '无法为连接 {{connectionId}} 建立远程助手',
  'Failed to establish remote server for {{connectionId}}':
    '无法为连接 {{connectionId}} 建立远程服务',
  'Checking SSH host...': '正在检查 SSH 主机...',
  'Resolving remote platform...': '正在识别远程平台...',
  'Preparing managed remote runtime...': '正在准备托管远程运行时...',
  'Uploading managed remote runtime...': '正在上传托管远程运行时...',
  'Extracting managed remote runtime...': '正在解压托管远程运行时...',
  'Syncing remote server files...': '正在同步远程服务文件...',
  'Starting remote server...': '正在启动远程服务...',
  'Waiting for remote server handshake...': '正在等待远程服务握手...',
  'Generated remote server source is invalid': '生成的远程服务代码无效',
  'Failed to start remote server': '启动远程服务失败',
  'Managed remote runtime verification failed during {{step}}':
    '托管远程运行时在“{{step}}”阶段校验失败',
  'Managed runtime node --version': '托管运行时 node --version 检查',
  'Managed remote server self-test': '托管远程服务自检',
  'Unsupported remote server mode': '不支持的远程服务模式',
  'Remote connection failed': '远程连接失败',
  'Connection stage': '连接阶段',
  'The remote host could not be prepared for repository attachment. Review the failure details below.':
    '无法为挂载远程仓库准备该主机。请查看下面的失败详情。',
  'Error details': '错误详情',
  'The app encountered an unexpected error.': '应用遇到了意外错误。',
  'You can try again, or reload the app.': '你可以尝试重试，或重新加载应用。',
  'Unknown remote profile: {{connectionId}}': '未知的远程配置：{{connectionId}}',
  'Remote platform unavailable for {{connectionId}}':
    '无法获取连接 {{connectionId}} 的远程平台信息',
  'Reveal in file manager is not supported for remote files': '远程文件暂不支持在文件管理器中定位',
  'Copying between local and remote files is not supported': '暂不支持本地与远程之间直接复制',
  'Copying across remote connections is not supported': '暂不支持跨远程连接复制',
  'Conflict detection between local and remote files is not supported':
    '暂不支持本地与远程之间的冲突检测',
  'Conflict detection across remote connections is not supported': '暂不支持跨远程连接的冲突检测',
  'Batch copy between local and remote files is not supported': '暂不支持本地与远程之间批量复制',
  'Batch copy across remote connections is not supported': '暂不支持跨远程连接批量复制',
  'Batch move between local and remote files is not supported': '暂不支持本地与远程之间批量移动',
  'Batch move across remote connections is not supported': '暂不支持跨远程连接批量移动',
  'Renaming across remote connections is not supported': '暂不支持跨远程连接重命名',
  'Moving between local and remote files is not supported': '暂不支持本地与远程之间直接移动',
  'Moving across remote connections is not supported': '暂不支持跨远程连接移动',
  'Failed to detect remote platform': '探测远程平台失败',
  'Failed to parse remote platform information': '解析远程平台信息失败',
  'Remote platform probe returned no JSON payload': '远程平台探测未返回 JSON 数据',
  'Only glibc-based Linux x64 and arm64 remote hosts are supported':
    '仅支持基于 glibc 的 Linux x64 和 arm64 远程主机',
  'Remote request timed out': '远程请求超时',
  'Not a remote virtual path: {{path}}': '不是有效的远程虚拟路径：{{path}}',
  'Malformed remote virtual path: {{path}}': '远程虚拟路径格式错误：{{path}}',
  'SSH command exited with code {{code}}': 'SSH 命令已退出，退出码 {{code}}',
  '{{feature}} is not supported for remote repositories yet': '远程仓库暂不支持{{feature}}',
  'Submodule history': '子模块历史',
  'Partial commit': '部分提交',
  'Git init': 'Git 初始化',
  'Submodule commit files': '子模块提交文件查看',
  'Commit diff variants': '提交差异变体',
  'AI commit message generation': 'AI 提交信息生成',
  'Code review': '代码审查',
  'GitHub CLI integration': 'GitHub CLI 集成',
  'Pull request listing': 'Pull Request 列表',
  'Pull request fetch': 'Pull Request 拉取',
  'AI branch name generation': 'AI 分支名生成',
  Stop: '停止',
  'Installing...': '安装中...',
  'Uninstalling...': '正在卸载...',
  Install: '安装',
  'CLI install success': 'CLI 安装成功',
  'CLI install failed': 'CLI 安装失败',
  'CLI uninstall success': 'CLI 卸载成功',
  'CLI uninstall failed': 'CLI 卸载失败',
  "'aiclient' command installed to {{path}}": "'aiclient' 命令已安装到 {{path}}",
  "'aiclient' command uninstalled": "'aiclient' 命令已卸载",
  "Uninstall 'aiclient' command": "卸载 'aiclient' 命令",
  "Install 'aiclient' command to PATH": "安装 'aiclient' 命令到 PATH",
  // PR Worktree
  'From branch': '从分支',
  'From PR': '从 PR',
  'Checking gh CLI...': '检查 gh CLI...',
  'GitHub CLI not installed': '未安装 GitHub CLI',
  'To create worktrees from pull requests, please install GitHub CLI:':
    '要从 Pull Request 创建 worktree，请安装 GitHub CLI:',
  'Learn more': '了解更多',
  'GitHub CLI not authenticated': '未登录 GitHub CLI',
  'Please authenticate with GitHub CLI:': '请登录 GitHub CLI:',
  Retry: '重试',
  'Pull Request': 'Pull Request',
  'Loading pull requests...': '加载 Pull Request...',
  'No open pull requests found': '没有打开的 Pull Request',
  'Search pull requests...': '搜索 Pull Request...',
  'Search models': '搜索模型',
  'Other models': '其他模型',
  'No pull requests found': '未找到 Pull Request',
  Draft: '草稿',
  'Select a pull request': '请选择一个 Pull Request',
  'Leave empty to use the PR branch name:': '留空则使用 PR 分支名:',
  optional: '可选',
  // Worktree settings
  'Git worktree save location settings': 'Git Worktree 保存位置设置',
  'Git auto refresh': 'Git 自动刷新',
  'Automatically fetch and refresh git status': '自动拉取远程更新并刷新 Git 状态',
  'Default directory for new worktrees. Leave empty to use ~/JYWAI/workspaces':
    '新建 Worktree 的默认目录，留空则使用 ~/JYWAI/workspaces',
  'Open Settings': '打开设置',
  // MCP Servers
  'MCP Servers': 'MCP 服务器',
  'No MCP servers configured': '暂无 MCP 服务器',
  'MCP server removed': 'MCP 服务器已移除',
  'MCP server saved': 'MCP 服务器已保存',
  'Edit MCP Server': '编辑 MCP 服务器',
  'Add MCP Server': '添加 MCP 服务器',
  'Configure MCP server connection settings': '配置 MCP 服务器连接设置',
  'Space separated': '空格分隔',
  Form: '表单',
  Config: '配置',
  'Invalid JSON or missing "command" field': '无效的 JSON 或缺少 "command" 字段',
  'Invalid JSON config': '无效的 JSON 配置',
  'Paste MCP config JSON with command, args, env fields':
    '粘贴包含 command、args、env 字段的 MCP 配置 JSON',
  'Paste MCP config JSON': '粘贴 MCP 配置 JSON',
  Type: '类型',
  'HTTP/SSE servers cannot be edited here': 'HTTP/SSE 服务器无法在此编辑',
  'Use "claude mcp" command to manage HTTP/SSE servers':
    '使用 "claude mcp" 命令管理 HTTP/SSE 服务器',
  ID: 'ID',
  Arguments: '参数',
  // Plugins
  Plugins: '插件',
  'No plugins installed': '暂无已安装插件',
  'Plugin installed': '插件已安装',
  'Plugin uninstalled': '插件已卸载',
  'Failed to install plugin': '安装插件失败',
  'Failed to uninstall plugin': '卸载插件失败',
  'Browse Plugins': '浏览插件',
  'Browse and install plugins from marketplaces': '从市场浏览和安装插件',
  'Search plugins...': '搜索插件...',
  'All Marketplaces': '所有市场',
  'No plugins found': '未找到插件',
  'No plugins available': '没有可用插件',
  Installed: '已安装',
  Uninstall: '卸载',
  // Marketplaces
  'Plugin Marketplaces': '插件市场',
  'Manage plugin marketplace sources': '管理插件市场源',
  'Marketplace added': '市场已添加',
  'Marketplace removed': '市场已移除',
  'Marketplace already exists': '市场已存在',
  'Failed to add marketplace': '添加市场失败',
  'Failed to remove marketplace': '移除市场失败',
  'Marketplaces updated': '市场已更新',
  'Failed to update marketplaces': '更新市场失败',
  'No marketplaces configured': '暂无市场',
  'Update All': '全部更新',
  // Prompts
  Prompts: '提示词',
  'No prompt presets configured': '暂无提示词预设',
  'Prompt preset removed': '提示词预设已移除',
  'Prompt activated': '提示词已激活',
  'Failed to activate prompt': '激活提示词失败',
  'Prompt saved': '提示词已保存',
  'Prompt template cannot be empty': '提示词模板不能为空',
  'Current CLAUDE.md not saved': '当前内容未保存为预设',
  'Edit Prompt': '编辑提示词',
  'Add Prompt': '添加提示词',
  'Create or edit a prompt preset for CLAUDE.md': '创建或编辑 CLAUDE.md 提示词预设',
  'Default Prompt': '默认提示词',
  'This content will be written to ~/.claude/CLAUDE.md': '此内容将写入 ~/.claude/CLAUDE.md',
  // AddRepositoryDialog
  'Add a local Git repository or clone from a remote URL.': '添加本地 Git 仓库或从远程 URL 克隆',
  Local: '本地',
  Remote: '远程',
  'Repository directory': '仓库目录',
  'Select a local Git repository...': '选择本地 Git 仓库...',
  Browse: '浏览',
  'Select an existing Git repository on your computer.': '选择计算机上已有的 Git 仓库',
  'Repository URL': '仓库 URL',
  'Supports HTTPS and SSH protocols.': '支持 HTTPS 和 SSH 协议',
  'Invalid URL format': 'URL 格式无效',
  'Valid URL': 'URL 有效',
  'Select a directory...': '选择目录...',
  'Repository name': '仓库名称',
  'Repository folder name': '仓库文件夹名',
  'The folder name for the cloned repository.': '克隆仓库的文件夹名称',
  'Full path': '完整路径',
  Clone: '克隆',
  'Cloning...': '克隆中...',
  'Clone failed': '克隆失败',
  'Failed to select directory': '选择目录失败',
  'Please select a local repository directory': '请选择本地仓库目录',
  'Please enter a valid Git URL': '请输入有效的 Git URL',
  'Please select a save location': '请选择保存位置',
  'Please enter a repository name': '请输入仓库名称',
  'Counting objects...': '正在计算对象...',
  'Compressing objects...': '正在压缩对象...',
  'Receiving objects...': '正在接收对象...',
  'Resolving deltas...': '正在解析增量...',
  'Target directory already exists. Please choose a different location or rename the repository.':
    '目标目录已存在，请选择其他位置或重命名仓库',
  'Authentication failed. Please check your system credentials.': '认证失败，请检查系统凭据',
  'SSH authentication failed. Please check your SSH key configuration.':
    'SSH 认证失败，请检查 SSH 密钥配置',
  'Remote repository not found. Please check the URL.': '远程仓库不存在，请检查 URL',
  'Unable to connect to remote repository. Please check your network.':
    '无法连接到远程仓库，请检查网络',
  'Invalid Git URL format. Please enter a valid HTTPS or SSH URL.':
    'Git URL 格式无效，请输入有效的 HTTPS 或 SSH URL',
  // Local path validation
  'Type a path or select from recent projects...': '输入路径或从最近项目中选择...',
  'No matching projects found': '未找到匹配的项目',
  'Path does not exist': '路径不存在',
  'Path is not a directory': '路径不是目录',
  'Valid directory': '目录有效',
  'Select a local directory on your computer.': '选择计算机上的本地目录。',
  'Validating...': '验证中...',
  // Clone Tasks
  'Clone Tasks': '克隆任务',
  'No clone tasks': '暂无克隆任务',
  'Preparing...': '准备中...',
  Completed: '已完成',
  tasks: '个任务',
  'and {{count}} more...': '还有 {{count}} 个...',
  // Diff Review Modal
  'Diff Review': '查看更改',
  'Leave a comment...': '留下评论...',
  'Reply...': '回复...',
  'Add reply...': '添加回复...',
  comments: '条评论',
  'Changed Files': '更改的文件',
  'Select a file to view diff': '选择文件以查看差异',
  'Hover over line numbers and click + to add comments': '悬停行号并点击 + 添加评论',
  You: '你',
  'Add comment': '添加评论',
  'Show split preview': '显示分屏预览',
  'Switch to fullscreen preview': '切换到全屏预览',
  'Close preview': '关闭预览',
  // Web Inspector
  'Web Inspector': 'Web Inspector',
  'Inspect web elements and send to agent': '检查网页元素并发送给 Agent',
  'Start Web Inspector server on port {{port}}': '在端口 {{port}} 启动 Web Inspector 服务',
  'Running on port {{port}}': '正在端口 {{port}} 运行',
  Stopped: '已停止',
  Unknown: '未知',
  'Unknown variable:': '未知变量：',
  'Unmatched braces detected in template': '模板中检测到不匹配的花括号',
  'Userscript Installation': '用户脚本安装',
  'Install the userscript to enable element inspection in your browser':
    '安装用户脚本以在浏览器中启用元素检查',
  'To use Web Inspector, you need to install a userscript in your browser.':
    '要使用 Web Inspector，您需要在浏览器中安装用户脚本。',
  or: '或',
  'browser extension': '浏览器扩展',
  'Click the button below to open the script installation page': '点击下方按钮打开脚本安装页面',
  'Click "Install" in the userscript manager': '在用户脚本管理器中点击「安装」',
  'Install Userscript': '安装用户脚本',
  Usage: '使用方法',
  'How to use Web Inspector': '如何使用 Web Inspector',
  'Enable Web Inspector above': '在上方启用 Web Inspector',
  'Open any webpage with the userscript installed': '打开任意已安装用户脚本的网页',
  'Click the userscript manager icon and select "Enable Web Inspector"':
    '点击油猴图标，选择「启用 Web Inspector」',
  'Click the AiClient button on the webpage': '点击网页上的 AiClient 按钮',
  'Click on any element to inspect': '点击任意元素进行检查',
  'Element info will be sent to your active agent session': '元素信息将发送到当前活跃的 Agent 会话',
  'Copy on Selection': '选中即复制',
  'Automatically copy selected text in the terminal to the clipboard':
    '自动将终端中选中的文本复制到剪贴板',
  // Logging
  Logging: '日志记录',
  'Enable Logging': '启用日志',
  'Enable logging to help diagnose issues. Logs are stored locally and never uploaded.':
    '启用日志记录以帮助诊断问题。日志存储在本地，不会上传。',
  'Log Level': '日志级别',
  Error: '错误',
  Warning: '警告',
  Info: '信息',
  Debug: '调试',
  'Only critical errors': '仅关键错误',
  'Errors and warnings': '错误和警告',
  'General information': '常规信息',
  'Detailed diagnostic information': '详细诊断信息',
  'Log Files': '日志文件',
  'Open Log Folder': '打开日志文件夹',
  'Log Retention': '日志保留',
  '7 days': '7 天',
  '14 days': '14 天',
  '30 days': '30 天',
  'Old log files will be automatically deleted': '旧日志文件将被自动删除',
  'No repository selected': '未选择仓库',
  Priority: '优先级',
  Low: '低',
  Medium: '中',
  High: '高',
  // Git Clone Settings
  'Git Clone': 'Git 克隆',
  'Base directory': '基础目录',
  'Organized structure': '组织结构',
  'Repository domains': '仓库域名',
  'Built-in mappings': '内置映射',
  'Settings for cloning remote Git repositories': '远程 Git 仓库克隆设置',
  'Base directory for cloned repositories. Leave empty to use ~/JYWAI/repos':
    '克隆仓库的基础目录。留空则使用 ~/JYWAI/repos',
  'Clone to organized structure (baseDir/host/owner/repo) or flat (baseDir/repo)':
    '克隆到组织结构（baseDir/host/owner/repo）或扁平结构（baseDir/repo）',
  'Host-to-directory mappings for organizing cloned repositories':
    '用于组织克隆仓库的域名到目录映射',
  'No mappings configured': '未配置域名映射',
  'Domain pattern': '域名格式',
  'Directory name': '目录名称',
  'Git host domain (e.g., gitlab.example.com or *.example.com)':
    'Git 仓库域名（例如：gitlab.example.com 或 *.example.com）',
  'Directory name for this host (e.g., gitlab, company-gitlab)':
    '此域名的目录名（例如：gitlab、company-gitlab）',
  'Pattern is required': '域名模式不能为空',
  'Directory name is required': '目录名称不能为空',
  'Pattern already exists': '域名模式已存在',
  'Map a Git repository domain to a directory name for organizing cloned repositories':
    '将 Git 仓库域名映射到目录名，以便组织克隆的仓库',
  'Use AI to generate a title and description from raw requirement text':
    '通过 AI 将原始需求文本生成简洁标题和 Agent 友好的内容',
  // Usage
  'Today calls': '今日调用次数',
  'Today cost': '今日费用',
  'This month cost': '本月费用',
  'Refresh usage': '刷新用量',

  // T-22: workspace shell — context panel surfaces
  // (Editor / Terminal already have entries above; reused as-is.)
  Context: '上下文',
  'Browse and edit workspace files': '浏览并编辑工作区文件',
  // T-32 (D27): the `editor` surface is the file tree now — the editor itself
  // moved to the center column, so its tab reads "Files".
  'Browse workspace files': '浏览工作区文件',
  // T-32 S3: A08 editor-head actions + the chat/editor grip. Button labels are
  // the constant name of the thing toggled (rail idiom) — state is aria-pressed's job.
  'Close file': '关闭文件',
  'Resize chat column': '调整对话栏宽度',
  'Working tree changes': '工作区变更',
  'Workspace terminal': '工作区终端',
  'Session context and runtime': '会话上下文与运行时',
  'Context surfaces': '上下文面板切换',
  // D08: the VSCode-style dock — rail entries, the panel title row, the center
  // session tab strip, and U16's composition chart.
  'Primary navigation': '主导航',
  'Sessions and repositories': '会话与仓库',
  // D12 (U24) retired the tab strip; `Open sessions` / `Close tab` /
  // `Open in a tab` went with it. The sidebar marker now states the real fact.
  'Running in the background': '正在后台运行',
  // U31: bulk archive from the sidebar.
  // Pre-existing gap surfaced by U31: the sidebar's own Archive action has read
  // English since T13 (the Button base class lowercases it, so it showed as
  // "archive"). The bulk button inherited it; one entry fixes both.
  Archive: '归档',
  'Select sessions to archive': '选择要归档的会话',
  '{{count}} selected': '已选 {{count}} 项',
  'Archive selected': '归档所选',
  'Archive selected sessions': '归档所选会话',
  'Archive {{count}} sessions? They will be removed from the sidebar.':
    '归档这 {{count}} 个会话？它们会从左栏移除。',
  'Their history stays on disk; this only clears them out of the list.':
    '历史记录仍留在磁盘上，这一步只是把它们从列表里清出去。',
  'No conversation open': '未打开对话',
  // Ending a conversation has to say which parts are lost (the running turn)
  // and which are not (the row, the history). Moved from the tab's ✕ to the
  // sidebar row's context menu, so the copy names the session instead of "this".
  'End this conversation?': '结束这个对话？',
  'Ending “{{name}}” stops its agent and releases it from the background.':
    '结束「{{name}}」会停止它的 agent，并把它从后台释放。',
  'This conversation is still running; its current turn will be cut off.':
    '这个对话还在运行，当前这一轮会被中断。',
  'It stays in the chat list and reopening it will load its history again.':
    '它仍然留在左栏会话列表里，重新打开会再次载入历史。',
  'End conversation': '结束对话',
  // D12 decision three: reclamation used to be silent in both directions.
  'A conversation moved to the background': '有一个对话已转入后台',
  '“{{name}}” was stopped to make room for a new one. Open it to continue.':
    '为了给新对话腾出位置，「{{name}}」已停止运行。点开它就能继续。',
  'An older conversation was stopped to make room for a new one.':
    '为了给新对话腾出位置，一个较早的对话已停止运行。',
  Composition: '构成',
  chars: '字符',
  'Message breakdown': '逐条消息',
  'Show context panel': '显示上下文面板',
  'Hide context panel': '隐藏上下文面板',
  'Expand panel': '展开面板',
  'Restore panel': '还原面板',
  'Close panel': '关闭面板',
  'Wide reading column': '宽阅读栏',
  'Standard reading column': '标准阅读栏',
  // D07: the reading-width control moved from MainHeader into Settings.
  'Reading column': '阅读栏宽度',
  'How wide conversation text is allowed to run': '对话正文允许占据多宽',
  'Let messages use the full column instead of a fixed reading width':
    '让消息铺满整栏，而不是限制在固定的阅读宽度内',
  // T-23: single-line MainHeader + LeftNav cleanup strings.
  'Context panel': '上下文面板',
  'No session selected': '未选择会话',
  // D07: MainHeader absorbed ChatWorkspace's own bar — the two axes it now
  // carries, plus the temporary-chat marker that came with it.
  'Two-column layout': '双栏布局',
  'Presentation mode': '显示方式',
  Temporary: '临时',
  'Expand sidebar': '展开侧栏',
  'Collapse sidebar': '收起侧栏',
  // H/18 S1 / S3: the sidebar's partition menus and the unread-result marker.
  'New temporary chat': '新建临时对话',
  'Finished while you were away': '你不在时已跑完，还没看过',
  'Failed while you were away': '你不在时失败了，还没看过',
  'Resize sidebar': '调整侧栏宽度',
  'Resize context panel': '调整上下文面板宽度',
  'Not connected yet — {{task}} will wire this surface.':
    '尚未接入 —— 该视图将由 {{task}} 完成接线。',
  'This surface has no view registered.': '该视图尚未注册。',

  // T-14: context surface (ContextSurfaceView) — definition-list group/row labels.
  Runtime: '运行时',
  Session: '会话',
  Path: '路径',
  Kind: '类型',
  'Model (actual)': '模型（实际）',
  'Model (configured)': '模型（配置）',
  'Reasoning effort': '推理强度',
  'Permission policy': '权限策略',
  'Permission policy not reported': '权限策略未上报',
  // D48 S3 — Settings 「Chat agent defaults」 permission templates.
  'Chat agent defaults': '对话 Agent 默认设置',
  'Applies to new chat sessions. Existing and active sessions keep the permission posture captured when they were first sent.':
    '仅作用于新建对话。已存在与进行中的会话，保持首次发送时捕获的权限姿态。',
  'Bypass permissions and danger-full-access remove the approval and sandbox limits that keep an agent inside this workspace. New sessions started under them can read and change anything this machine can, with no prompt to stop it.':
    'Bypass permissions 与 danger-full-access 会移除把 Agent 限制在本工作区内的审批与沙箱边界。以此档启动的新会话可以读写这台机器能触及的一切，且不会再有任何提示可以拦下。',
  'Make this the default for new sessions?': '把该档设为新会话默认？',
  'This tier is not applied yet. Confirm to store it as the starting posture for every new chat on this agent; cancel to keep the current one.':
    '该档尚未生效。确认后它将成为该 Agent 上每个新对话的起始姿态；取消则保留当前档。',
  'Use this tier': '使用该档',
  'Dangerous tier is the current default': '当前默认为危险档',
  'Permission mode': '权限模式',
  'Approval policy': '审批策略',
  'Sandbox mode': '沙箱模式',
  'Network access': '网络访问',
  'Reported by runtime': '由运行时上报',
  'Runtime default': '运行时默认',
  'Whatever the runtime itself defaults to.': '采用运行时自身的默认值。',
  'Plan only — no edits, no commands.': '仅做规划——不改文件、不执行命令。',
  'Ask before every tool use.': '每次使用工具前都询问。',
  'File edits apply without asking; other tools still ask.': '文件修改直接生效；其他工具仍会询问。',
  'Approvals are answered for you; the sandbox still applies.': '审批被自动回答；沙箱仍然生效。',
  'No approval prompts at all. Anything the agent decides to run, runs.':
    '完全没有审批提示。Agent 决定执行什么就执行什么。',
  'Only a trusted allow-list runs unattended.': '仅信任名单内的操作可无人值守执行。',
  'The agent asks when it wants to escalate.': 'Agent 需要提权时会询问。',
  'Never asks — the sandbox is the only remaining limit.': '从不询问——沙箱是仅存的边界。',
  'No writes at all.': '完全不可写。',
  'Writes confined to the workspace.': '写入限制在工作区内。',
  'No sandbox. Full read and write access to this machine.':
    '没有沙箱。对这台机器拥有完整读写权限。',
  'Accept edits': '自动接受编辑',
  "Don't ask": '不再询问',
  'Bypass permissions': '跳过权限确认',
  Plan: '规划',
  // D48 S4 — the Composer's live (mid-session) permission chip.
  'Applies from your next message — a turn already running keeps the tier it started with.':
    '从你的下一条消息起生效——已经在跑的这一回合仍沿用它开始时的档位。',
  'Applies immediately, to this thread.': '立即生效，作用于当前线程。',
  'Bypass permissions and danger-full-access remove the approval and sandbox limits on THIS chat. From the moment they apply, the agent can read and change anything this machine can, with no prompt to stop it.':
    'Bypass permissions 与 danger-full-access 会移除「当前这个对话」的审批与沙箱边界。一旦生效，Agent 就能读写这台机器能触及的一切，且不会再有任何提示可以拦下。',
  'Remove the limits on this chat?': '移除当前对话的限制？',
  'This tier has not been applied. Confirm to run this chat without approval prompts or a sandbox; cancel to stay on the current tier. Only this chat changes — the default for new chats is untouched.':
    '该档尚未生效。确认后当前对话将在无审批提示、无沙箱的情况下运行；取消则保持当前档。只影响这一个对话——新建对话的默认档不受影响。',
  'Apply to this chat': '应用到当前对话',
  'Permission tier unchanged': '权限档未变更',
  // The chip's assembled copy: templates, so the tier label and the scope
  // sentence are each translated before they are put together.
  'This chat has nowhere to run right now.': '当前对话暂时没有可运行的目标。',
  'The Agent Host is not ready.': 'Agent Host 尚未就绪。',
  'A turn is running — the tier is fixed for the turn already in flight.':
    '正在进行一个回合——已在飞行中的这一回合，档位已经定型。',
  'A permission change is already on its way.': '已有一次权限变更在路上。',
  'applying…': '正在应用…',
  '{{tier}} from your next message': '{{tier}}（自下一条消息起）',
  '{{tier}} pending': '{{tier}}（待生效）',
  'Permissions: {{tier}} — click to change ({{scope}})':
    '权限：{{tier}} —— 点击可修改（{{scope}}）',
  'Permissions: {{tier}} — {{reason}}': '权限：{{tier}} —— {{reason}}',
  'Permission tier: {{tier}} — {{scope}}': '权限档：{{tier}} —— {{scope}}',
  'Permission tier: {{tier}} ({{pending}}) — {{scope}}':
    '权限档：{{tier}}（{{pending}}） —— {{scope}}',
  // U12 — session-level permission tier chip labels and descriptions.
  'Read-only': '只读',
  'Can read and search, cannot edit files or run commands.':
    '可以读取和搜索，不能编辑文件或执行命令。',
  Pragmatic: '务实',
  'Shipped defaults — reads are free, changes ask for confirmation.':
    '随包默认——读取免确认，修改需要确认。',
  'Hands-off': '放手',
  'File edits inside the workspace apply without asking; commands, and anything outside it, still ask.':
    '工作区内的文件修改直接生效；命令、以及工作区之外的任何操作仍会询问。',
  'Full access': '完全放开',
  'Approves most actions automatically, including writes outside the workspace. Secret-file protection remains.':
    '自动批准大部分操作，包括工作区之外的写入。密钥文件保护仍然生效。',
  'Remove limits on this chat?': '移除当前对话的限制？',
  'Full access approves most tool calls automatically, including reads and writes outside this workspace. Only secret-file protection remains. This applies to this chat only.':
    '「完全放开」会自动批准大部分工具调用，包括工作区之外的读写。仅保留密钥文件保护。该设置仅作用于当前对话。',
  Apply: '应用',
  // D10 explicit degradation. The copy must never name a tier as the effective
  // policy — on this path it is the user's own config, which a `yoloMode: true`
  // file makes laxer than every tier the picker lists.
  'Your own policy': '你自己的策略',
  'This chat runs on the permission system in your own agent directory; the tiers here do not apply.':
    '这个对话跑在你自己 agent 目录里的权限系统上，这里的档位不生效。',
  'Permission tiers are off for this chat': '当前对话的权限档不生效',
  'It runs on the permission system in your own agent directory.':
    '它跑在你自己 agent 目录里的权限系统上。',
  'Host status': 'Host 状态',
  'Process ID': '进程 ID',
  Driver: '驱动',
  Turn: '当前回合',
  'Pending permissions': '待处理授权',
  'Sent attachments': '已发送附件',
  Mentions: '@ 引用',
  'Runtime identity': '运行时身份',
  'No context reported yet.': '暂无可展示的上下文。',

  // U07: context surface — composition of the conversation THIS WINDOW has
  // loaded. The wording never says "context window": the runtime reports no
  // usage and the catalog strips the window size, so the panel can only speak
  // for the transcript it holds.
  'Conversation (loaded)': '对话构成（已加载）',
  '{{count}} messages · {{chars}} chars in this window': '本窗口 {{count}} 条消息 · {{chars}} 字符',
  user: '用户',
  assistant: '助手',
  system: '系统',
  error: '错误',
  '(no text in this message)': '（该消息没有文本内容）',
  '… truncated': '…已截断',

  // U06-a: run surface (RunSurfaceView). 'Status', 'Failed', 'Completed',
  // 'Model (actual)' / 'Model (configured)' and 'No active session' are reused
  // from the keys above — the Run panel names the same facts the Context panel
  // does, and a second translation of one word is how the two drift apart.
  Run: '运行',
  'Live turn status': '当前回合运行状态',
  Idle: '空闲',
  Starting: '启动中',
  Running: '运行中',
  'Running a tool': '正在执行工具',
  Thinking: '思考中',
  'Waiting for approval': '等待审批',
  'Waiting for an answer': '等待回答',
  Stopping: '停止中',
  // 'Disconnected' already exists above (host status) with the same meaning.
  'No session': '无会话',
  'No model configured': '未配置模型',
  'No active session.': '暂无活动会话。',
  'Nothing has run yet.': '尚未运行过任何回合。',
  Elapsed: '已用时',
  'Last turn': '上一回合',
  'Tool calls': '工具调用',
  'Failed tools': '失败工具',

  // U06-b: context occupancy and the usage row, all runtime-reported (T38).
  'Context used': '上下文占用',
  Used: '已占用',
  Free: '剩余',
  'Context window': '上下文窗口',
  'Input (last turn)': '输入（上一回合）',
  'Output (last turn)': '输出（上一回合）',
  'Cache read': '缓存读取',
  'Cache write': '缓存写入',
  // A1: `cacheRead / (input + cacheRead)`, cache writes excluded from the base.
  'Cache hit rate': '缓存命中率',
  Cost: '费用',
  // A2: the conversation total, deliberately labelled apart from the
  // per-turn figures above it — the two are never added together.
  'Turns (session)': '回合数（本会话）',
  '{{turns}} + {{delegated}} delegated': '{{turns}} + {{delegated}} 次委派',
  'Input (session)': '输入（本会话累计）',
  'Output (session)': '输出（本会话累计）',
  'Cache read (session)': '缓存读取（本会话累计）',
  'Cost (session)': '费用（本会话累计）',
  // decision 005 — the delegated share of the session totals above.
  'Delegated (session)': '其中委派（本会话累计）',
  '{{tokens}} · {{percent}}%': '{{tokens}} · {{percent}}%',
  '{{used}} of {{window}} context used': '上下文已占用 {{used}} / {{window}}',

  // T-12: git surface (GitSurfaceView) — empty states and diff sub-header.
  'No active session': '暂无活动会话',
  'Select a chat session to view its git changes.': '选择一个聊天会话以查看其 Git 变更。',
  'Workspace path unavailable': '工作区路径不可用',
  "This session's workspace has no resolved path yet.": '该会话的工作区尚未解析出路径。',
  'This workspace is not tracked by Git.': '此工作区未纳入 Git 版本管理。',
  'Back to changes': '返回变更列表',
  // D30(a): History section (GitHistoryList) — 'History' and 'No commits yet'
  // are reused from existing keys above (sessions sidebar / CommitHistoryList).
  'Load more': '加载更多',

  // T-13: editor surface (EditorSurfaceView) — empty state and intent failure notices.
  'Select a Workspace to browse files': '选择工作区以浏览文件',
  'Could not open "{{path}}" — the path is outside the workspace.':
    '无法打开 "{{path}}"——该路径在工作区之外。',
  'Could not open "{{path}}".': '无法打开 "{{path}}"。',
  'Dismiss notice': '关闭提示',

  // T-15: terminal surface (TerminalSurfaceView / compact TerminalPanel).
  'Expand the panel to manage terminal splits': '展开面板以管理终端分屏',
  'Select a session to open a terminal': '选择一个会话以打开终端',
  'This session has no workspace': '该会话没有工作区',
  'This workspace has no local path': '该工作区没有本地路径',

  // T-27: Composer target bar (D22) — data rows (batch 2).
  'Search folders…': '搜索文件夹…',
  'Search worktrees…': '搜索 worktree…',
  Recents: '最近',
  'On This PC': '本机',
  'Remote repositories': '远程仓库',
  // 'Worktrees' already exists above (WorktreePanel title) — reused as-is.
  'No folders found': '未找到文件夹',
  'No worktrees found': '未找到 worktree',
  'This PC': '本机',
  'Run location': '运行位置',
  'Read-only indicator. The run location is derived from the repository: local shows This PC, remote shows the connection name; it is hidden entirely when unknown.':
    '只读指示器，不是下拉。运行位置由仓库属性派生：本机显示 This PC，远程显示连接名；数据缺失时整块隐藏。',
  'Session is running — stop it before changing the target': '会话运行中——先停止再切换目标',
  'This chat already has messages — a new chat will start on the new target':
    '当前会话已有消息——将在新目标下新建对话',

  // T12-e: welcome card shown above the composer when no working directory
  // has been picked yet (replaces a red "looks broken" diagnostic box).
  'Choose a working directory': '选择工作目录',
  'No working directory yet': '还没有工作目录',
  'Pick a folder first — the agent works inside it.': '先选一个目录，AI 就在这个目录里干活。',
  // U05-b: the card no longer blocks the composer, so its copy stopped saying
  // "first" — you can talk right now; picking a folder is what unlocks working
  // ON something.
  'Pick a folder to work on a project — the agent works inside it. Without one, this chat runs in a private temporary folder.':
    '想让 AI 在你的项目里干活，就选一个目录——AI 只在这个目录里操作。不选也能直接聊，这时会用一个私有的临时目录。',

  // U28: the start screen. `Just start chatting` (U22) is gone with the button
  // it labelled — the composer below is live now, so there is nothing to click.
  'Start a conversation': '开始对话',
  // U29: the scope line the permission chip shows before a chat exists.
  'Applies to new chats.': '作用于新建的对话。',
  'The agent will work inside {{folder}} — type what you want done.':
    'AI 会在 {{folder}} 里干活，直接说你想做什么。',
  'Just type. This chat runs in a private temporary folder.':
    '直接输入即可，这次对话会在一个私有的临时目录里进行。',
  'Waiting for model': '等待模型响应',
  'Writing response': '正在输出',
  'Running tool': '执行工具',
  'Waiting for confirmation': '等待确认',
  Retrying: '正在重试',
  'Retry in {{seconds}}s': '{{seconds}} 秒后重试',
  'Waiting for retry response': '等待重试响应',
  'Chat file changes': '聊天中的文件修改',
  'Edit shows modification diffs; Write shows content only. Bash changes are not captured.':
    'Edit 显示修改差异；Write 仅显示写入内容。暂不捕获 Bash 的文件修改。',
  'Show file modification diff': '显示文件修改 diff',
  'Input tokens': '输入',
  'Output tokens': '输出',
  'Total tokens': '合计 tokens',
  'Not reported': '未上报',
  '{{count}} tokens remaining': '剩余 {{count}} tokens',
  'Latest settled model request': '最近一次模型请求（已结算）',
  'Conversation total since load': '会话累计（本次加载以来）',
  'model requests': '次模型请求',
  'Tools in current turn': '本轮工具调用',
  'No tool calls in this turn': '本轮没有调用工具',
  'Tool token usage, reasoning tokens and generation speed are not reported with comparable measurements.':
    '暂无分工具 token、推理 token 和生成速度的同口径计量。',
  'Modification preview': '修改预览',
  'Modification failed': '修改失败',
  'Written content': '写入内容',
  'Failed — preview only; application unconfirmed': '修改失败——仅参数预览，未确认应用',
  'Written content — previous content unavailable': '写入内容——无修改前内容可供比较',
  'Applied diff': '已应用的修改差异',
  'Successful edit — argument preview': '修改成功——按参数预览差异',
  'Submitting…': '提交中…',
  'New temporary workspace': '新建临时工作区',
  'New chat in existing directory: {{path}}': '在现有目录新建会话（沿用目录）：{{path}}',
  'Stop the current turn before starting a new chat': '请先停止当前任务，再新建会话',
  'New temporary chat (no repository)': '新建临时对话（没有仓库）',

  // T-27: Composer target bar (D22) — footer action rows (batch 3).
  // 'New Folder' already exists above (worktree/temp-session UI) — reused as-is.
  'Use Existing…': '使用已有目录…',
  'Clone…': '克隆…',
  'Add Remote…': '添加远程…',
  'Temporary workspace': '临时工作区',
  'New worktree…': '新建 worktree…',
  'New worktree "{{name}}"…': '新建 worktree「{{name}}」…',
  'Worktree created — pick it from the branch list': 'worktree 已创建——请在分支列表中选择',
  'Temp workspace created — pick it from the folder list': '临时工作区已创建——请在文件夹列表中选择',
  'Temp workspace created': '临时工作区已创建',
  'Failed to create temp workspace': '创建临时工作区失败',

  // T-28: Composer round action button (D23) — aria-label/title (batch 3).
  'Send message': '发送消息',
  'Stop the running turn': '停止当前回合',
  'Retry last message': '重试上一条消息',
  // T-19: fourth round-button kind — "send, only delayed" while a turn runs.
  'Queue message': '加入队列',

  // D47 S5 §1.4: the three-state user profile chip (WindowTitleBar /
  // UserProfileCard, `deriveUserProfilePresentation`) — 'attention'
  // (credentials_invalid/locked) vs. 'signed-out' (signed_out/unknown) copy.
  'Login expired': '登录已过期',
  'Not signed in': '未登录',
  'Sign in again': '重新登录',
  'Sign in': '登录',

  // ── 批次 4：硬编码英文残留（2026-09-11）────────────────────────────────
  //
  // 上一轮补的是「走了 t() 却没有词条」的那批。这一批不一样：这些字符串
  // 根本没经过 t()，所以 i18nCoverage 扫不到，中文界面里就一直是英文。
  //
  // 时间线的工具动词、思考动词、子 Agent 面板动词。这些词以「键」的形式一路
  // 传到 ToolRows.tsx 才翻译（见 ToolRowView.verb），所以扫描器看不到它们 —
  // 同目录的 toolVocabulary 测试专门盯住这三张表。
  Read: '读取',
  Reading: '读取中',
  Edited: '已编辑',
  Ran: '已运行',
  Grep: '搜索内容',
  Grepped: '已搜索内容',
  Grepping: '搜索内容中',
  'Searched files': '已搜索文件',
  'Searching files': '搜索文件中',
  // subagent-data-06 — this app's own registered tools. They had no entry at
  // all, so every one of these rows read as the unknown-tool fallback 已运行.
  Previewed: '已预览',
  Previewing: '预览中',
  Asked: '已询问',
  Asking: '询问中',
  Ask: '询问',
  'Loaded skill': '已加载技能',
  'Loading skill': '加载技能中',
  'Load skill': '加载技能',
  'Started a new context': '已开新上下文',
  'Starting a new context': '开新上下文中',
  'Start a new context': '开新上下文',
  'Waited for subagents': '已等待子 Agent',
  'Waiting for subagents': '等待子 Agent 中',
  'Wait for subagents': '等待子 Agent',
  'Listed subagents': '已列出子 Agent',
  'Listing subagents': '列出子 Agent 中',
  'List subagents': '列出子 Agent',
  'Stopped subagents': '已停止子 Agent',
  'Stopping subagents': '停止子 Agent 中',
  'Stop subagents': '停止子 Agent',
  Called: '已调用',
  Calling: '调用中',
  Call: '调用',
  Listed: '已列出',
  Listing: '列出中',
  Searched: '已搜索',
  Searching: '搜索中',
  Fetched: '已获取',
  Fetching: '获取中',
  Planned: '已规划',
  Planning: '规划中',
  Delegate: '委派',
  Delegated: '已委派',
  Delegating: '委派中',
  Explored: '已浏览',
  Exploring: '浏览中',
  Thought: '已思考',
  briefly: '片刻',
  'Worked for': '耗时',
  Subagent: '子 Agent',
  Said: '回复',
  Capped: '已达上限',

  // 工具行的参数段。这些带占位符，必须在构造时就翻译好。
  'for {{duration}}': '耗时 {{duration}}',
  '{{pattern}} in {{repo}}': '{{pattern}}（{{repo}}）',
  '{{count}} tool call': '{{count}} 次工具调用',
  '{{count}} tool calls': '{{count}} 次工具调用',
  '{{count}} tool': '{{count}} 个工具',
  '{{count}} tools': '{{count}} 个工具',
  '{{count}} search': '{{count}} 次搜索',
  '{{count}} searches': '{{count}} 次搜索',
  '{{count}} edit': '{{count}} 次编辑',
  '{{count}} edits': '{{count}} 次编辑',
  '{{count}} file': '{{count}} 个文件',
  '{{count}} tokens': '{{count}} tokens',
  // chat-tool-03: T020 wrote these arg strings without t(), so the Chinese UI
  // rendered mixed text such as '已开新上下文 a fresh window'. The count entry is
  // split into singular / plural keys per repo convention.
  'a fresh window': '一个干净的上下文',
  '{{count}} delegation': '{{count}} 个委派',
  '{{count}} delegations': '{{count}} 个委派',
  'all running': '全部运行中',
  'running subagents': '运行中的子 Agent',
  'working directory': '工作目录',
  'next moves': '后续计划',

  // 子 Agent 面板。
  'From subagent': '来自子 Agent',
  'From subagent · {{detail}}': '来自子 Agent · {{detail}}',
  'Awaiting permission · {{tool}}': '等待授权 · {{tool}}',
  '+{{count}} earlier': '另有 {{count}} 条更早的',
  'activity feed capped — remaining live updates dropped': '活动流已达上限 —— 后续实时更新不再显示',

  // 权限卡。Allow / Deny 复用权限设置页已有的「直接允许 / 直接拒绝」：
  // 在卡片上按下去就是直接放行/拒绝这一次，两处读法一致。
  Permission: '权限',
  'Allow for session': '本会话内允许',
  // T002 — decision 003:授权按会话生效，不按委派归属收敛，卡片上要把这一点说清楚。
  'Applies to every agent in this session, including subagents':
    '对本次会话内的所有代理生效，含子代理',
  'Deny and stop': '拒绝并停止',
  Allowed: '已允许',
  'Allowed for session': '本会话内已允许',
  Denied: '已拒绝',
  'Denied, turn stopped': '已拒绝，本轮已停止',
  Waiting: '等待中',
  'diff clamped': '差异已截断',
  'High risk': '高风险',
  'Needs confirmation': '需确认',
  'Low risk': '低风险',
  'The runtime reported no command for this request': '运行时未报告命令内容',
  'The runtime offered {{count}} more options this build cannot show':
    '运行时还提供了 {{count}} 个本版本未支持的选项，未显示',
  'This command also asked for extra permissions ({{files}} file entries / network {{network}})':
    '此命令还申请了额外权限（文件系统 {{files}} 项 / 网络 {{network}}）',
  'Also grants writes under {{path}} for this session': '同时允许在 {{path}} 下写入，本会话有效',
  '{{count}} more files are not shown': '另有 {{count}} 个文件未显示',
  'cwd: {{path}}': '工作目录：{{path}}',
  'Network: {{target}}': '网络：{{target}}',
  'auto: {{reason}}': '自动：{{reason}}',
  // chat-event-07: wording for the worker-side PermissionAutoReason enum
  // (questionCardModel's PERMISSION_AUTO_REASONS emits the English keys; the
  // Chinese copy lives here).
  unsupported: '不支持',
  'session closed': '会话已关闭',
  aborted: '已中止',
  'Project: {{name}}': '项目：{{name}}',
  'Denied automatically if unanswered within {{seconds}}s': '若 {{seconds}} 秒内未响应将自动拒绝',
  yes: '是',
  no: '否',

  // 审批记录行（T08-b）。surface / origin / matchedPattern 是插件自己的标识符，
  // 原样透出；这里翻的是包在它们外面的那层话。
  request: '请求',
  'for a subagent': '代子 Agent 请求',
  'for subagent {{name}}': '代子 Agent {{name}} 请求',
  'Permission check failed — {{surface}}': '权限检查失败 —— {{surface}}',
  'Awaiting approval — {{surface}}': '等待审批 —— {{surface}}',
  'Denied {{surface}}': '已拒绝 {{surface}}',
  'Allowed {{surface}}': '已允许 {{surface}}',
  'matched {{pattern}}': '命中规则 {{pattern}}',
  'from {{origin}}': '来自 {{origin}}',
  // 插件的 resolution 枚举去掉下划线后当键用：认得的照这里翻，不认得的原样显示。
  'policy allow': '策略放行',
  'gate error': '闸门出错',
  // chat-event-07: the remaining four resolutions the in-house gate actually
  // produces; the Chinese UI used to show them in raw English. 'timed out' is
  // also permissionAutoReason's timed_out.
  'session grant': '本会话已授权',
  'policy deny': '策略拒绝',
  'timed out': '已超时',
  cancelled: '已取消',

  // 输入框占位与排队提示。
  'Creating session with Agent Host (first message only)…':
    '正在与 Agent Host 建立会话（仅首条消息）…',
  'Sending to Agent Host…': '正在发送到 Agent Host…',
  'Sending {{count}} attachment to Agent Host…': '正在向 Agent Host 发送 {{count}} 个附件…',
  'Sending {{count}} attachments to Agent Host…': '正在向 Agent Host 发送 {{count}} 个附件…',
  'Add more optional details…': '可以再补充一些信息…',
  'Queued {{count}} — type another follow-up…': '已排队 {{count}} 条 —— 可以接着输入…',
  'Agent Host is running — your message will be queued…':
    'Agent Host 正在运行 —— 你的消息会先排队…',
  'Active session has no workspace…': '当前会话没有工作区…',
  'Choose a working directory to start…': '先选一个工作目录…',
  'Send follow-up…': '继续输入…',
  'Message Pi…': '给 Pi 发消息…',
  'Cannot send right now…': '现在无法发送…',
  'Move queued message up': '把排队消息上移',
  'Move queued message down': '把排队消息下移',
  'Edit queued message': '编辑排队消息',
  'Remove queued message': '移除排队消息',

  // 回合进行中的状态行。等待动词按秒轮换，整张表都要有词条。
  'Starting Agent Host… · {{seconds}}s': '正在启动 Agent Host… · {{seconds}}s',
  'Still waiting · {{seconds}}s': '仍在等待 · {{seconds}}s',
  'past the usual range; no reply and no error yet. Stop to abort.':
    '已超出常见时长；既没有回复也没有报错。按停止可中止。',
  'gateway latency varies. Stop to abort.': '网关延迟本身就有波动。按停止可中止。',
  'Retry {{attempt}}/{{max}}': '重试 {{attempt}}/{{max}}',
  'Sent {{size}}': '已发送 {{size}}',
  Pondering: '思索中',
  Percolating: '酝酿中',
  Ruminating: '琢磨中',
  Noodling: '盘算中',
  Mulling: '掂量中',
  Simmering: '慢炖中',
  Marinating: '腌制中',
  Cogitating: '推敲中',
  Deliberating: '斟酌中',
  Brewing: '冲泡中',
  Puzzling: '解谜中',
  Contemplating: '沉思中',

  // 会话分支对话框（整个文件此前没有接过 i18n）。
  'Session branches': '会话分支',
  'Rewinding changes the active path. Later messages stay in this tree and are not deleted.':
    '回退只改变当前路径。之后的消息仍留在这棵树里，不会被删除。',
  '{{shown}} of {{total}} nodes': '共 {{total}} 个节点，显示 {{shown}} 个',
  'Load the Pi-native session tree': '加载 Pi 原生会话树',
  'Showing a bounded window; {{count}} nodes are hidden.':
    '只显示有限范围，另有 {{count}} 个节点未显示。',
  active: '当前',
  'Rewind here': '回退到这里',
  Rewind: '回退',
  'Rewind this session?': '确认回退这个会话？',
  'The active conversation will move to “{{node}}”. Later messages remain available as another branch and the Pi session file is not truncated.':
    '当前对话会切到「{{node}}」。之后的消息会保留为另一条分支，Pi 的会话文件不会被截断。',
  'Fork from here': '从这里分叉',
  'Fork becomes available after the first assistant response': '要等助手给出第一条回复后才能分叉',
  'Fork was created, but its workspace could not be materialized in this window':
    '分叉已创建，但它的工作区无法在这个窗口里装载',
  'This session has no persisted tree nodes yet.': '这个会话还没有落盘的树节点。',

  // 模型按钮的可访问名与 tooltip。屏幕阅读器按界面语言念，所以也走词条。
  'applies to the next turn': '对下一轮生效',
  'Model and reasoning effort: {{selection}} — {{scope}}':
    '模型与思考强度：{{selection}} —— {{scope}}',
  '{{selection}} — click to change model or reasoning effort ({{scope}})':
    '{{selection}} —— 点击可更换模型或思考强度（{{scope}}）',

  // --- 硬编码中文改走词典（2026-09-11）------------------------------------
  // 用户决定：界面上出现英文可以接受，只要意思清楚。于是这批原本写死在组件里的
  // 中文一律改成「英文即键」，和批次 4 的工具动词同一套办法——纯函数模块吐键，
  // 渲染那一层统一翻一次。这样切到英文界面时它们才会跟着变。
  '(no preview)': '（无预览）',
  'Add the model in Pi settings': '去 Pi 设置补上模型',
  "Another process holds this chat's write lock, so it was not opened. Nothing on disk was changed.":
    '另一个进程正持有这个会话的写入锁，所以没有打开它。磁盘上的内容没有任何改动。',
  'Asks before each write, edit and command.': '写入、编辑和命令逐条询问。',
  'Auto-accept edits': '自动接受编辑',
  // D14 第四档：完全放行（bypass）。它不会成为新会话默认，所以只在已有会话里可选。
  'Bypass all prompts': '完全放行',
  'Never asks. Even commands full auto would stop to confirm run straight through; explicit deny rules still apply.':
    '完全不再询问。连「全自动」都会停下来确认的命令也直接执行；明确的拒绝规则依然生效。',
  'Turn off every approval prompt?': '关闭全部授权询问？',
  'Every tool call runs without asking, including the commands full auto still stops to confirm. Explicit deny rules still apply. This is never saved as the default for new chats.':
    '所有工具调用都不再询问，包括「全自动」仍会停下确认的那些命令。明确的拒绝规则依然生效。该档位不会被保存为新对话的默认。',
  'Can be turned on once this chat exists.': '需要先有对话才能开启。',
  'Carries out approved work.': '执行已批准的工作。',
  'Check that Claude Code or Codex has been used on this machine and that its session directory holds JSONL records.':
    '请确认本机使用过 Claude Code 或 Codex，且会话目录中存在 JSONL 记录。',
  "Copies history read-only from this machine's Claude Code or Codex session directories, so you can carry on in Pi":
    '从 Claude Code 或 Codex 的本机会话目录只读复制历史，并在 Pi 中继续',
  'Could not detect the Pi runtime': '无法检测 Pi 运行时',
  Deferred: '后置',
  Details: '详情',
  Email: '邮箱',
  'Enter the code': '输入验证码',
  'Enter your email to receive a verification code.': '输入邮箱以接收验证码。',
  Execute: '执行',
  'Failed to load the PDF': 'PDF 加载失败',
  'Failed to read history': '读取历史失败',
  'Failed to render the page': '页面渲染失败',
  'Fit width': '适应宽度',
  'Force takeover': '强制接管',
  'Full auto': '全自动',
  'Get started': '开始使用',
  'Grid view': '网格视图',
  'Held by process {{pid}} on {{host}}, for {{duration}}.':
    '已被进程 {{pid}}（主机 {{host}}）持有 {{duration}}。',
  'Held by process {{pid}} on {{host}}.': '已被进程 {{pid}}（主机 {{host}}）持有。',
  'Held by process {{pid}}, for {{duration}}.': '已被进程 {{pid}} 持有 {{duration}}。',
  'Held by process {{pid}}.': '已被进程 {{pid}} 持有。',
  'History is encrypted — unreadable here': '历史已加密，此处读不到',
  'History not found': '未找到历史',
  'History unavailable for this agent': '该 agent 的历史暂不可读',
  'Import history': '导入历史',
  'Import report: {{imported}} new snapshots, {{existing}} already there, {{failed}} failed. Imported sessions are not opened automatically.':
    '导入报告：{{imported}} 个新快照，{{existing}} 个已存在，{{failed}} 个失败。导入完成后不会自动打开会话。',
  'Investigates and submits a plan, then waits for approval.': '勘察并提交实现计划，等待批准。',
  'Keep the original file for recovery; start a new chat to carry on.':
    '请保留原文件用于恢复；新建会话后再继续工作。',
  'Loading Mermaid diagram...': '加载 Mermaid 图表…',
  'Loading PDF...': '加载 PDF…',
  'Mermaid render error': 'Mermaid 渲染错误',
  'Migrate or add the AI service under Settings · Pi and this chat can continue; you can also switch to a model this app already has, from above the composer.':
    '到「设置 · Pi」把 AI 服务迁移或补上，这个会话就能继续；也可以在输入框上方改用一个本应用已有的模型。',
  'Model is not available here': '本应用没有这个模型',
  'No history was found for this chat when resuming it, so no past messages were loaded.':
    '恢复该会话时没有找到它的历史记录，历史消息没有载入。',
  'No importable sessions found': '未找到可导入会话',
  'No sessions found': '未找到会话',
  'Only {{suffixes}} addresses are accepted.': '仅接受 {{suffixes}} 后缀。',
  'Open it from the workspace it belongs to, or start a new chat.':
    '请从该会话原本的工作区打开，或新建会话继续。',
  'Permission change did not take': '权限未生效',
  'Pi models and credentials are active for this session.': 'Pi 模型与凭据已在本次会话中生效。',
  'Pi session service is starting…': 'Pi session service 正在启动…',
  'Pi session service stopped': 'Pi session service 已停止',
  'Pi session service failed': 'Pi session service 出错',
  'Press Retry to initialise the Pi session service': '点击「重试」初始化 Pi session service',
  'Press Retry to reinitialise the Pi session service': '点击「重试」重新初始化 Pi session service',
  'Reading or parsing the history file failed, so the history below may be missing or incomplete.':
    '读取或解析历史文件时出错，下面的历史可能缺失或不完整。',
  Resend: '重新发送',
  'Resend in {{seconds}}s': '{{seconds}}s 后可重发',
  'Resending...': '重发中…',
  'Restore the directory at its original path and retry, or archive this chat and start a new one.':
    '请把该目录恢复到原路径后重试，或归档该会话并新建一个继续工作。',
  'Retrying works once the other writer lets go; until then this chat cannot be opened here.':
    '等对方释放后再重试即可；在那之前，这个会话无法在这里打开。',
  'Runs the available tools automatically; explicit deny rules still apply.':
    '自动执行可用工具；显式拒绝规则仍生效。',
  'Runs the tools available in the current mode automatically, including operations outside the workspace; explicit deny rules still apply.':
    '自动执行当前模式下的可用工具，包括工作区外操作；显式拒绝规则仍生效。',
  'Select all in this project': '全选当前项目',
  'Send code': '发送验证码',
  'Sending may or may not still work; if it fails, start a new chat to carry on.':
    '不保证还能继续发送；若发送失败，请新建会话继续。',
  'Sending may still work; if it fails the same way, start a new chat.':
    '会话或仍可继续发送；若发送同样失败，请新建会话。',
  'Sent to {{email}}. Check your inbox, including spam.':
    '已发送至 {{email}}，请查收邮件（含垃圾箱）。',
  'Server address': '服务地址',
  'Session belongs to another workspace': '该会话属于另一个工作区',
  'Session history is damaged': '会话历史已损坏',
  // ah-lib-03: runtime's session_size_limit needs its own card: the file is
  // neither missing nor corrupt, this build just refuses to load it whole.
  'Session history is too large to open': '会话历史过大，本版本无法打开',
  // concurrency-02: another process holds the writer lock. The pid and the age
  // are what let a user judge whether that writer can still be real.
  'Session is locked by another writer': '会话被另一个写入者锁定',
  'Sign up': '注册',
  'Sign-in required': '需要重新登录',
  'Signed in': '登录完成',
  'Take the lock only if that writer is really gone. If it is still running, two processes will write to this chat at once and messages can be lost.':
    '只有确认那个写入者确实已经退出，才去接管。它若仍在运行，就会有两个进程同时写入这个会话，消息可能丢失。',
  'That code has already been used. Send a new one.': '验证码已被使用，请重新发送。',
  'That code has expired. Send a new one.': '验证码已过期，请重新发送。',
  'That did not work. Please try again.': '操作失败，请重试。',
  'That email address is not valid.': '邮箱格式不正确。',
  'The Pi session file is not a valid session. The app has not modified or replaced the original file.':
    'Pi 会话文件不是有效会话，应用没有修改或替换原文件。',
  'The Pi session record belongs to a different workspace than this repository, so a silent rebind was refused.':
    'Pi 会话记录的工作区与当前仓库不一致，因此已拒绝静默重绑。',
  'The bundled Pi worker runtime could not be found.': '没有找到随包的 Pi worker 运行时。',
  'The chat is mid-turn; you can retry reading history once this turn ends.':
    '会话正在进行中，本轮结束后可重试读取历史。',
  'The chat is mid-turn; you can take the session over once this turn ends.':
    '会话正在进行中，本轮结束后可强制接管。',
  'The chat is not interrupted; you can keep sending messages.': '会话未中断，可以继续发送消息。',
  'The email could not be sent. Please try again later.': '邮件发送失败，请稍后再试。',
  'The history file is encrypted and this process cannot read it as plain text. That does not mean the chat has no history — the record is still on disk, it just cannot be shown here.':
    '历史文件已加密，本进程读不到明文。这不代表该会话没有历史——记录仍在磁盘上，只是无法在此显示。',
  'The history read returned an unknown error, so the history below may be missing or incomplete.':
    '历史读取返回了未知错误，下面的历史可能缺失或不完整。',
  'The probe failed — it may be an IPC, permission or environment problem. Try again; if it keeps failing, check the error log in developer tools.':
    '探测过程出错，可能是 IPC、权限或环境问题。请重试；如果反复失败，请查看开发者工具中的错误日志。',
  'The request was malformed. Please try again.': '请求格式错误，请重试。',
  'The retry did not take; history still could not be read. You can try again later.':
    '重试未生效，历史仍未读到，可稍后再试一次。',
  'The service hit an internal error. Please try again later.': '服务内部错误，请稍后再试。',
  'The service is temporarily unavailable. Please try again later.': '服务暂时不可用，请稍后再试。',
  'The takeover did not go through; the session is still held by another writer.':
    '接管未生效，会话仍被另一个写入者持有。',
  'The working directory this chat is bound to is no longer on disk, so its worker cannot start. The app will not recreate a directory it did not create.':
    '该会话绑定的工作目录已不在磁盘上，因此无法启动它的 worker。应用不会替你重建自己创建的目录。',
  'This chat’s record is larger than this build will load in one piece, so it was not opened. The file itself is intact and untouched on disk.':
    '这个会话的记录超过了本版本一次性加载的上限，因此没有打开。文件本身完好，磁盘上未被改动。',
  'Start a new chat to carry on; the original record stays where it is.':
    '新建会话继续；原记录保持原样。',
  'This build cannot read history for that agent yet, so earlier messages were not loaded. The record is still on disk.':
    '当前版本还读不到该 agent 的历史记录，更早的消息没有载入；记录仍在磁盘上。',
  'This chat cannot continue: with its history gone, the next send will fail. Start a new chat to carry on.':
    '该会话已无法继续：历史记录缺失后，继续发送会失败；请新建会话继续工作。',
  'This chat is pinned to a model this app does not have, so it could not be started. This app uses its own agent directory, and AI services you set up in your own Pi directory do not come across on their own.':
    '这个会话记录的模型不在本应用的模型目录里，所以没能把它启动起来。本应用用自己的 agent 目录，你原先在自己的 Pi 目录里配好的 AI 服务不会自动带过来。',
  'This project has no session records to import.': '该项目下没有可导入的会话记录。',
  'Too many attempts. Please try again later.': '操作过于频繁，请稍后再试。',
  'Too many wrong attempts. Send a new code.': '错误次数过多，请重新发送验证码。',
  'Turn on full auto?': '启用全自动？',
  'Unknown error.': '未知错误。',
  'Use a different email': '更换邮箱',
  'Verification code': '验证码',
  'Verify and sign up': '验证并注册',
  'Welcome, {{name}}.': '欢迎，{{name}}。',
  'What was produced is kept. You can resend the last message from the composer below.':
    '已产内容保留。可从下方输入框重发上条消息。',
  'Workspace folder is gone': '工作目录已不存在',
  'Writes, edits and commands inside the workspace run automatically; paths outside it still ask.':
    '工作区内写入、编辑和命令自动执行；外部路径仍询问。',
  'Wrong code.': '验证码错误。',
  'Wrong code. {{count}} attempts left.': '验证码错误，还可重试 {{count}} 次。',
  Yesterday: '昨天',
  'You can switch back to your own local configuration in Settings at any time.':
    '随时可以在设置里切换回使用本机自己的配置。',
  'Your sign-in has expired. Sign in again and retry.': '登录状态已失效，请重新登录后再试。',
  'Your sign-in has expired. Verify your email again.': '登录已失效，请重新验证邮箱。',
  // concurrency-02: the one lock age that is a phrase rather than a number.
  // `2h5m` needs no entry — it passes through the dictionary unchanged.
  'less than a minute': '不到 1 分钟',
  '{{count}} digits, valid for 15 minutes.': '{{count}} 位数字，15 分钟内有效。',
  '{{count}} sessions': '{{count}} 个会话',
  '{{count}} snapshots imported': '已导入 {{count}} 个快照',
  // The turn work group's head. Three duration keys rather than one with a
  // pre-formatted `{{duration}}`: English writes "1m 6s" and Chinese writes
  // 「1 分 6 秒」, so the unit words belong to the CATALOG, not to the
  // renderer. `deriveTurnWorkGroupLabel` hands over plain numbers and the
  // render site picks the key. 「已处理 N 个步骤」 is the fallback for a turn
  // with no timestamps at all (restored history) — never a fabricated 0 秒.
  Working: '工作中',
  'Worked for {{seconds}}s': '已工作 {{seconds}} 秒',
  'Worked for {{minutes}}m {{seconds}}s': '已工作 {{minutes}} 分 {{seconds}} 秒',
  'Worked for {{minutes}}m': '已工作 {{minutes}} 分',
  '{{count}} steps processed': '已处理 {{count}} 个步骤',
  '{{month}}/{{day}}': '{{month}} 月 {{day}} 日',

  // T023 — copy the RUNTIME produces. It reaches here as an identifier
  // (`PermissionRequestAction`, `HistoryNotice.key`) precisely because the
  // worker that produces it has no locale; these four plus the import banner
  // were hardcoded Chinese until 2026-09-15 and rendered Chinese on English
  // installs. The permission wording lives in `questionCardModel.ts`
  // (`PERMISSION_ACTION_LABELS`), which is what makes the English side a key.
  'Run a command in the workspace': '在工作区运行命令',
  'Write a file in the workspace': '写入工作区文件',
  'Modify a file in the workspace': '修改工作区文件',
  'Read file contents': '读取文件内容',
  'This history was imported from a {{sourceKind}} session ({{sourceSessionId}}). You can keep talking here; the original run state — tools, permissions — did not come across.':
    '这段历史从 {{sourceKind}} 会话 {{sourceSessionId}} 导入。可以在这里接着聊；原来的运行状态（工具、权限）没有一起带过来。',

  // T067 — copy that was never routed through `t()` at all. All four groups
  // below were photographed on 2026-09-17 sitting inside an otherwise Chinese
  // screen, which is why they are one batch rather than four: the defect is
  // not the wording, it is that these surfaces never asked the catalog.

  // D20 — the question card. Its permission sibling renders in the same shell
  // and was fully translated; these five plus the skipped mark were bare
  // constants, so a Chinese user saw 「权限」 and 「Questions」 side by side.
  Questions: '提问',
  Answers: '回答',
  'Questions skipped': '已跳过提问',
  'Other…': '其他…',
  Skip: '跳过',
  Skipped: '已跳过',
  // Identity on purpose: a key chord is not a sentence. The entry exists so a
  // locale that words it differently has a place to say so.
  'Ctrl + Enter': 'Ctrl + Enter',

  // D21 — the transport-retry banner. Four keys rather than two templates with
  // a `+`: the attempt count sits mid-sentence in English and at the end in
  // Chinese, so the presence of the count picks the key instead of patching a
  // hole in one. `{{counts}}` is a bare ratio ('2' / '2/10') and needs no
  // translating — the composer one line below has printed it that way all
  // along.
  'Network retry — the turn is still running': '网络重试中 · 本回合仍在进行',
  'Network retry {{counts}} — the turn is still running':
    '网络重试中 · {{counts}} · 本回合仍在进行',
  'Upstream error {{status}} — retrying, the turn is still running':
    '上游返回错误 {{status}} · 正在重试 · 本回合仍在进行',
  'Upstream error {{status}} — retrying {{counts}}, the turn is still running':
    '上游返回错误 {{status}} · 正在重试 {{counts}} · 本回合仍在进行',
  'Next attempt in {{delay}}': '{{delay}} 后重试',

  // D26 — the Composer's attachment sentences, refusals and hint alike. They
  // share one folded notice, so they are translated together: a Chinese list
  // under an English header is the same defect one layer up.
  'Pasted item': '粘贴的内容',
  'Pasted image': '粘贴的图片',
  image: '图片',
  'text file': '文本文件',
  'an unknown image type': '未知的图片格式',
  '"{{name}}" is empty — skipped.': '「{{name}}」是空文件，已跳过。',
  'Up to {{max}} attachments per message — "{{name}}" skipped.':
    '每条消息最多 {{max}} 个附件，已跳过「{{name}}」。',
  '"{{name}}" is {{size}} — max {{max}} per {{what}}.':
    '「{{name}}」有 {{size}}，单个{{what}}最大 {{max}}。',
  'Attachments would total {{size}} — max {{max}} per message. Remove one first.':
    '附件合计将达 {{size}}，每条消息最多 {{max}}，请先移除一个。',
  '"{{name}}" is {{type}} — only JPEG, PNG, GIF and WebP are supported.':
    '「{{name}}」是 {{type}}，只支持 JPEG、PNG、GIF 和 WebP。',
  '"{{name}}" is {{width}}x{{height}}px — max {{max}}px on the longer edge.':
    '「{{name}}」是 {{width}}x{{height}} 像素，长边最大 {{max}} 像素。',
  'Attachments total {{size}} — sending may take longer.': '附件合计 {{size}}，发送可能会慢一些。',
  '"{{name}}" is not an image or text file — skipped.':
    '「{{name}}」既不是图片也不是文本文件，已跳过。',
  'Could not read "{{name}}" — skipped.': '读取「{{name}}」失败，已跳过。',
  '"{{name}}" is not a file — skipped.': '「{{name}}」不是文件，已跳过。',
  '"{{name}}" looks like binary data — skipped.': '「{{name}}」看起来是二进制数据，已跳过。',
  '{{count}} attachments skipped: {{reasons}}': '已跳过 {{count}} 个附件：{{reasons}}',

  // D9 — the import refusal. The main process has no locale, so it now sends a
  // code plus the ceiling it enforced; these two sentences are where that
  // becomes Chinese, where 67108864 becomes 64 MiB, and where the user is told
  // what to do next instead of being handed a number.
  'This conversation has more than {{limit}} records, past the import limit. Import a smaller conversation, or split it up first.':
    '这个对话的记录条数超过了 {{limit}} 条的导入上限，没能导入。请改导入较小的对话，或先拆分后再导入。',
  'This conversation is larger than {{size}}, past the import limit. Import a smaller conversation, or split it up first.':
    '这个对话的体积超过了 {{size}} 的导入上限，没能导入。请改导入较小的对话，或先拆分后再导入。',

  // --- 提示词缓存存活时长（主对话 / 子代理各一档）----------------------------
  // 两档分开，是因为两种循环的缓存经济学相反：主对话是一段不断增长、每轮都会被
  // 重读的前缀，值得买一小时；子代理是一次性爆发，写完的前缀没人再读，多付的写入
  // 溢价收不回来。
  '1 hour': '1 小时',
  '5 minutes': '5 分钟',
  'Prompt cache': '提示词缓存',
  'Main conversation': '主对话',
  'How long the provider keeps the main conversation cached between turns. One hour costs a little more on each write and saves the whole prefix on every turn that follows a pause longer than five minutes.':
    '供应商在两轮之间为主对话保留缓存的时长。选 1 小时，每次写入会略贵一点，但只要中间停顿超过 5 分钟，下一轮就能整段命中缓存。',
  'Takes effect the next time a conversation starts its runtime.': '在对话下一次启动运行时生效。',
  'Subagent prompt cache': '子代理提示词缓存',
  'A delegate writes a prefix nothing reads again, so five minutes is usually the cheaper choice. Takes effect the next time a conversation starts its runtime.':
    '子代理写出的前缀之后没人再读，所以通常 5 分钟更划算。在对话下一次启动运行时生效。',
};

export function normalizeLocale(input?: string): Locale {
  if (!input) return 'en';
  return input.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function getTranslation(locale: Locale, key: string): string {
  if (locale === 'zh') {
    return zhTranslations[key] ?? key;
  }
  return key;
}

export function translate(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>
): string {
  const template = getTranslation(locale, key);
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, token) => {
    const value = params[token];
    return value === undefined ? match : String(value);
  });
}

/**
 * The shape `useI18n().t` has, restated without React so the renderer's PURE
 * text modules can take one as a parameter.
 *
 * They have no hook to call and no business subscribing to a store: a module
 * that folds blocks into a view model must stay a function of its inputs. So
 * the locale arrives the same way every other input does — passed in by the
 * component that is already holding `t`.
 */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * The default for those parameters: English, i.e. the key with its `{{…}}`
 * filled in.
 *
 * This is what makes the parameter safe to add to an existing signature. A call
 * site that has not been threaded yet keeps producing exactly the bytes it
 * produced before, which is also the correct output for `locale === 'en'` — so
 * an un-threaded path is a missing TRANSLATION, never a broken string.
 */
export const englishTranslate: Translate = (key, params) => translate('en', key, params);

/**
 * Changing the permission gear in the middle of a turn.
 *
 * The composer control used to grey out entirely while a turn ran, which put
 * the one setting that stops approval cards out of reach at the exact moment a
 * card was on screen. The gear is live now; the mode is still locked, and these
 * three strings are how the UI says which is which — plus the word the resolved
 * card carries once a widened gear has answered it.
 */
Object.assign(zhTranslations, {
  'While this turn runs, only the permission level can change.': '本轮对话进行中只能修改权限档位。',
  'Can be changed once this turn ends.': '本轮对话结束后可修改。',
  'permissions widened': '权限已放宽',
});

/**
 * What 「本会话内允许」 actually remembers.
 *
 * The grant stopped being one exact call — it is a directory with everything
 * under it, or a command prefix — so the card has to say which, or the button
 * promises something the user cannot see. Its own block at the end of the file
 * for the usual reason: several people add strings here on the same day.
 */
Object.assign(zhTranslations, {
  'Allow for session remembers commands starting with {{prefix}}':
    '「本会话内允许」会记住以 {{prefix}} 开头的命令',
  'Allow for session remembers {{tool}} anywhere under {{path}}':
    '「本会话内允许」会记住 {{tool}} 可访问 {{path}} 及其子目录',
});

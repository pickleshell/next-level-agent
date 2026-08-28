# Next-Level OpenCode Profile — техническое задание и архитектура

**Статус:** Draft 0.4 — финальный архитектурный аудит, требуется утверждение
**Дата:** 2026-08-23
**Репозиторий:** `pickleshell/next-level-agent`
**Целевая версия:** OpenCode `1.17.9` (stable V1 configuration schema)

## 1. Определение продукта

Продукт — репозиторий-локальный configuration pack для OpenCode, а не отдельная
система, daemon, база данных или внешний оркестратор.

Поставка должна использовать нативные механизмы OpenCode:

- primary agent и subagents;
- Task delegation в дочерние сессии;
- per-agent models, permissions и limits;
- лениво загружаемые skills;
- custom commands;
- project-local custom tools и plugin hooks;
- автоматическую compaction и pruning;
- worktree/diff audit, bounded file/content search, точечный read, опциональный experimental
  LSP и статистику usage.

Цель — максимизировать качество принятого результата при минимальной стоимости
одной принятой задачи (`cost per accepted task`). При конфликте целей приоритеты
следующие:

1. безопасность и отсутствие потери данных;
2. корректность и выполнение Definition of Done;
3. минимизация fresh input, output, reasoning tokens и фактически списанной стоимости;
4. скорость выполнения.

Минимальное число токенов само по себе не считается успехом, если результат не
проходит проверку.

## 2. Границы поставки

### 2.1. Входят в первую версию

- `opencode.jsonc` (либо adopted existing `opencode.json`) с runtime-настройками
  и ролевой привязкой моделей;
- pack-owned `PROFILE_RULES.md` и контракт интеграции с user-owned `AGENTS.md`;
- prompts для primary agent и специализированных subagents;
- core skills и правила установки project-specific skills;
- custom commands для явных workflow;
- обязательный project-local guard/search plugin как нативное расширение OpenCode;
- компактные шаблоны долговременного контекста проекта;
- валидатор конфигурации и permissions;
- тонкий managed launcher для герметичного config environment и non-LLM profile doctor;
- безопасный installer/updater/uninstaller с manifest-lock;
- benchmark-набор для измерения качества, токенов и стоимости;
- README по установке, привязке моделей и эксплуатации.

### 2.2. Не входят в первую версию

- собственный runtime или API поверх OpenCode;
- хранение истории всех сессий;
- автономное изменение требований пользователя;
- выбор конкретных провайдеров и названий моделей;
- хранение API-ключей в репозитории;
- универсальная интеграция со всеми IDE;
- production-профиль для OpenCode V2 beta;
- жёсткая межпроцессная блокировка нескольких OpenCode-сессий;
- внешний daemon, proxy или отдельный orchestration runtime.

Project-local plugin не является отдельной системой: он загружается самим OpenCode
по explicit local entry и закрывает известные ограничения pinned V1 runtime, которые
невозможно безопасно выразить только permission globs.
Managed launcher также не оркестрирует задачи и не проксирует provider traffic: он
только проверяет lock/preflight, задаёт изолированное окружение и выполняет штатный
OpenCode process.

## 3. Совместимость и версия OpenCode

Reference implementation разрабатывается и тестируется на OpenCode `1.17.9`.
Используется V1 schema:

- `agent`, а не `agents`;
- `permission`, а не `permissions`;
- `bash` и `task`, а не `shell` и `subagent`;
- `prompt`, `disable`, `steps`;
- `compaction.prune` и `compaction.reserved`.

Reference template V1 запрещено смешивать с native примерами из `/v2/docs`. V2
может нормализовать часть V1 fields, но имеет собственную schema и migration
semantics; он тестируется отдельным бинарником `opencode2` и остаётся отдельным
будущим профилем.

Обновление OpenCode выполняется только после прохождения validator и regression
benchmark. Нормативное значение `autoupdate` — `false`.

Reference platform — Linux/macOS на local filesystem с POSIX atomic create/rename;
Windows поддерживается через WSL. Network filesystems и native Windows требуют
отдельного lease/path regression profile и до него получают Fail, а не ослабление
guard semantics.
Core managed launch не сосуществует с system-managed OpenCode config: Linux/WSL
`/etc/opencode`, macOS managed Application Support и MDM plist сначала проверяются
без импорта кода; наличие любого источника даёт Fail до отдельного organization
profile. Launcher затем направляет managed-config directory в controlled empty
`0700` root. На macOS MDM plist этим override не подавляется, поэтому его наличие
безусловно отключает hard-profile.

## 4. Архитектурные принципы

1. **Native-first.** Используются config, agents, permissions, skills, commands,
   custom tools и plugin hooks самого OpenCode; внешний runtime не вводится.
2. **Direct-first.** Простая задача не должна порождать subagents и context packet.
3. **Risk-based delegation.** Стоимость маршрута зависит от риска и неизвестности,
   а не только от размера запроса.
4. **Fresh child context.** Subagent получает самостоятельный краткий контракт,
   а не копию переписки primary session.
5. **Least privilege.** Каждая роль получает только необходимые executable tool,
   skill и subagent catalogs; mixed permission maps остаются видимыми только ролям,
   которым capability действительно нужна.
6. **Lazy instructions.** Постоянный prompt минимален; условные процедуры находятся
   в skills.
7. **Serialized writers.** Orchestrator обязан последовательно запускать write-задачи;
   это policy, а не встроенная блокировка OpenCode.
8. **Evidence before state.** Непроверенный результат не попадает в долговременное
   состояние.
9. **Fail-fast.** Отсутствующая модель, skill или некорректный config являются
   ошибкой, а не поводом для тихого fallback.
10. **Model-role separation.** Prompts описывают способности роли, а реальные
    модели привязываются при установке.
11. **Measurement over intuition.** Экономия подтверждается provider-reported
    usage и benchmark, а не длиной prompt на глаз.

## 5. Границы технических гарантий

### 5.1. OpenCode и обязательный project-local guard обеспечивают

- выбор primary agent через `default_agent`;
- детерминированный managed launch без примеси пользовательского global config;
- запрет source-edit через `edit: deny` и запрет shell там, где он не нужен;
- allowlist вызываемых subagents через `permission.task`;
- запрет вложенного делегирования через `task: deny` у каждого subagent;
- soft finish warning через `steps` и hard LLM/Task-call caps через guard hooks;
- отдельную модель для каждой роли;
- скрытие недоступных skills через skill permissions;
- автоматическую compaction и pruning старых tool outputs;
- изоляцию command в child session через `subtask: true`;
- pre/post worktree evidence; rollback выполняется только явным безопасным Git/manual workflow.

Сам V1.17.9 имеет пять существенных пробелов: `grep` permission проверяет regex,
а не пути; Task может materialize `@file` без child `read` approval; Unix path checks
лексические и не учитывают symlink target; `apply_patch` проверяет source, но не
`*** Move to:` destination; built-in `webfetch` не защищает private/link-local targets
и redirects. Поэтому профиль fail-closed требует pack-owned `profile-guard` plugin,
который также регистрирует `safe_search` и `safe_fetch` custom tools:

- committed base config задаёт root и каждой роли permission wildcard
  `"*": "deny"`, явно оставляет risk capabilities denied, устанавливает
  `formatter: false`, `lsp: false` и `disable: true` для всех известных primary/subagent/
  maintenance agents; до успешного guard activation невозможен даже LLM call;
- guard является единственным external plugin и через `config` hook последним
  атомарным присваиванием устанавливает и включает intended six agents + compaction,
  оставляет остальные agents disabled, фиксирует commands, `mcp: {}` и ordered
  permission maps; `lsp` остаётся `false`, кроме отдельно валидированного exact profile;
- built-in `grep` и `glob` запрещены всем ролям, `safe_search` выполняет bounded
  file/content search через `rg` без shell, `--follow`, `--hidden` и `--no-ignore`,
  проверяя каждый search root;
- `safe_search.execute` до enumeration разрешает active role по `sessionID` и первым
  действием вызывает native `ctx.ask` для permission `safe_search` с exact pattern;
  unknown/denied role завершается до filesystem access, guard before-hook дублирует gate;
- built-in `webfetch` запрещён всем, а Scout использует bounded HTTPS-only
  `safe_fetch` с permission/role gate и SSRF/redirect/DNS validation;
- hook `tool.execute.before` отклоняет attachment-синтаксис в Task prompt;
- тот же hook отклоняет `apply_patch` move syntax и проверяет все path arguments;
- `chat.params` перед каждым logical `LLM.stream` attempt сначала fail-closed сверяет
  active role, provider/model, approved variant/options с locked model snapshot
  (включая resume/direct agent/compaction), затем для outer retry того же message
  атомарно резервирует budget в durable per-root ledger и отклоняет
  вызов сверх per-role/root cap; main work calls сохраняют AI SDK `maxRetries: 0`.
  Task hook аналогично резервирует cumulative child call до создания child session;
- существующий target разрешается через `realpath`, новый target — через `realpath`
  ближайшего существующего parent; symlink-компоненты запрещены;
- `lsp.filePath` проходит ту же canonical worktree проверку; отдельного built-in
  `list` tool в V1.17.9 нет, а guard разрешает built-in `read` только для существующего
  canonical regular file. Directory и missing target отклоняются до listing/typo
  suggestions; discovery выполняет только filtered `safe_search mode=files`;
- resolved path обязан оставаться внутри worktree; guard по `sessionID` разрешает
  active role и применяет тот же ordered policy: `deny` отклоняется, `ask` передаётся
  native permission flow, explicit example `allow` сохраняется. `safe_search` не
  имеет per-match approval и поэтому всегда исключает secret candidates.

Plugin подключается одним explicit local path из `opencode.jsonc`. Production entry
point — pack-owned `opencode-profile`, который перед каждым запуском без LLM проверяет
lock/origin hashes и static preflight, отклоняет `--pure` и config/plugin override
flags, любые share/auto-share flags, изолирует все XDG roots, `OPENCODE_TEST_HOME` и
managed-config directory, удаляет все inherited `OPENCODE_*` по deny-by-default
правилу и запрещает external skill discovery. Затем он выставляет только
launcher-controlled `OPENCODE_TEST_HOME`, `OPENCODE_TEST_MANAGED_CONFIG_DIR`,
`OPENCODE_DISABLE_EXTERNAL_SKILLS=true`, `OPENCODE_DISABLE_LSP_DOWNLOAD=true` и явно
`OPENCODE_DISABLE_MODELS_FETCH=true`, hash-verified `OPENCODE_MODELS_PATH` и явно
включённый policy feature flag. Единственный optional core feature flag —
`OPENCODE_EXPERIMENTAL_LSP_TOOL=true`, если LSP profile прошёл проверки; остальные
`OPENCODE_*` не наследуются. Изолированный persistent runtime находится вне worktree
в owner-only per-user profile root, имеет
mode `0700` и закрыт model tools правилами containment/`external_directory`; provider
auth допускается только через exact deployment allowlist env/API/OAuth credentials.
Stored auth metadata проверяется без вывода секретов: `type: "wellknown"`, active
OpenCode account/org remote config и любой иной pre-guard remote-config source дают
Fail и требуют отдельного conditional profile.

Если guard отсутствует или не загружается, launcher не вызывает OpenCode. Если hook
не активировался внутри уже запущенного процесса, committed `disable: true` не даёт
выбрать agent или вызвать provider, wildcard denies закрывают tool surface, а config
среда не содержит foreign MCP/plugin/command/skill sources. Прямой `opencode`,
`--pure` или запуск с host global config являются unmanaged и не входят в hard
guarantees: V1.17.9 может подключить merged remote MCP независимо от tool permission.
Validator обязан различать эти состояния; любой неуспешный guard smoke test блокирует
managed work.

V1.17.9 `resolveTools` schema-фильтр удаляет tool, когда итоговое permission для exact
pattern `"*"` равно `deny`. Поэтому полностью запрещённые role tools действительно не
попадают в LLM map; capability с mixed allow/ask/deny rules остаётся видимой и
проверяется повторно при execution. Validator тестирует оба уровня, а benchmark всё
равно измеряет фактический cold-input floor вместо расчёта по именам tools.

### 5.2. Следующие свойства остаются policy, а не hard guarantee

- корректность классификации сложности и риска;
- соблюдение размера Task Context Packet;
- динамическое ограничение Implementer только файлами текущего packet;
- точный per-task token/dollar budget: guard ограничивает число вызовов, но размер и
  фактический provider bill отдельного вызова заранее неизвестны;
- raw provider HTTP retries внутри adapter/network stack: hard cap относится к
  logical OpenCode stream attempts, фактические requests/cost проверяет telemetry;
- последовательность `Implement → Verify → Review → Checkpoint`;
- single-writer даже внутри одной session и отсутствие writers в других процессах;
- запись Notebook исключительно во время checkpoint;
- обязательный checkpoint перед прямым `/new`, закрытием или аварийным завершением;
- полнота и истинность Notebook-записей;
- отсутствие symlink TOCTOU race между guard pre-check и built-in tool execution:
  профиль запрещает symlinks, но hard race isolation потребовала бы замены всех
  filesystem tools или OS sandbox;
- confidentiality внутреннего indexing LSP server: experimental LSP остаётся
  optional и отключается для репозиториев с жёсткой secret boundary;
- безопасная sanitization аргументов native custom command: V1.17.9 выполняет
  shell/file interpolation до `command.execute.before`, поэтому shipped commands
  являются zero-argument, а передача им аргументов запрещена operational contract;
- запрет намеренного прямого `@subagent` вызова пользователем: permissions роли
  сохраняются, но Orchestrator workflow при таком вызове обходится;
- confidentiality после явно одобренного shell command или project verification:
  OpenCode не анализирует произвольные side effects и output такого процесса.

Эти ограничения должны быть отражены в prompts, post-diff проверках, validator и
документации. Нельзя описывать их как технически гарантированные без более сильной
изоляции или внешней координации.

## 6. Артефактная архитектура и установка

Configuration pack поставляется как installer-managed overlay. Исходный репозиторий
pack и установленный target layout разделены: служебный benchmark не копируется в
проект пользователя, а runtime-файлы берутся из явно перечисленных template/script
sources.

### 6.1. Исходный репозиторий pack

```text
README.md
VERSION
profiles/
└── models.env.example
scripts/
├── install-profile.sh
├── run-profile.sh
├── profile-doctor.sh
├── validate-config.sh
└── benchmark.sh
benchmark/
├── scenarios/
├── expected/
└── profiles/
    └── baseline/
        ├── opencode.jsonc
        └── baseline-manifest.json
template/
├── opencode.jsonc
└── .opencode/
    ├── .gitignore
    ├── package.json
    ├── package-lock.json
    ├── PROFILE_RULES.md
    ├── profile/
    │   ├── guard.ts
    │   ├── argv-policy.json
    │   ├── lsp-safe-servers.json
    │   └── policy.json
    ├── prompts/
    │   ├── orchestrator.md
    │   ├── explorer.md
    │   ├── scout.md
    │   ├── architect.md
    │   ├── implementer.md
    │   └── reviewer.md
    ├── commands/
    │   ├── route.md
    │   ├── review.md
    │   ├── diagnose.md
    │   ├── checkpoint.md
    │   ├── handoff.md
    │   └── status.md
    ├── skills/
    │   └── <skill-name>/SKILL.md
    └── notebook/
        ├── MANIFEST.md
        ├── INDEX.md
        ├── DECISIONS.md
        └── STATE.md
```

Agents объявляются в `opencode.jsonc`. Их большие prompts подключаются через
`{file:./.opencode/prompts/<role>.md}`, а модели — через `{env:...}`. Это позволяет
валидировать единую schema и не полагаться на подстановку env-переменных в YAML
frontmatter agent Markdown.

Root `plugin` list содержит ровно один explicit local entry для
`./.opencode/profile/guard.ts`; auto-discovered или global external plugins в core
profile запрещены. Project-specific plugin требует отдельного audited profile, где
guard остаётся последним hook и regression probes подтверждают тот же deny-mode.

Skills всегда используют переносимый формат
`.opencode/skills/<name>/SKILL.md` с корректным YAML frontmatter.
Каждый разрешённый skill связан не только с именем, но и с canonical relative origin
и SHA-256 в lock. Core запрещает `skills.paths`, `skills.urls`, duplicate logical
names и любой discovered skill вне adopted origin map. Project-specific skill сначала
проходит явное adoption и получает собственный locked origin/hash; одного совпадения
имени недостаточно. Единственное core exception — pinned V1.17.9 built-in
`customize-opencode` с pseudo-origin `<built-in>`: binary/source version и expected
content hash attested в lock, `permission.skill` для него exact deny у всех ролей,
а slash alias безопасно shadowed. Он discovered, но никогда не allowed.

`.opencode/profile/guard.ts`, `.opencode/package.json` и `package-lock.json` являются частью
одной pinned compatibility unit. Guard одновременно реализует enforcement hooks и
регистрирует `safe_search`/`safe_fetch`. Package содержит только точную совместимую версию
`@opencode-ai/plugin`, а npm lock фиксирует resolved artifact и integrity; runtime
dependency drift запрещён. V1.17.9 config loader использует npm/Arborist и
`package-lock.json`, не Bun lock. Custom tool запускает `rg` через argv API без shell
interpolation; наличие поддерживаемой версии `rg` проверяется preflight.

`profile/argv-policy.json` — pack-owned strict contract pinned CLI 1.17.9. Launcher
парсит argv структурно (`--flag=value`, short aliases, `--`, positionals) и принимает
только mode-specific subcommands/flags; substring filtering запрещён. Production
разрешает TUI только для canonical current locked worktree без project positional,
bounded `run` с prompt/`--format`/resume того же isolated session, read-only
`models`/`agent list`, а также exact isolated `auth` operations. Он запрещает
`--attach`, `--dir`, file attachment, `--dangerously-skip-permissions`, share,
model/variant/agent override, remote/server credentials и любой unknown flag.
`attach`, `plugin`, `upgrade`, `uninstall`, `mcp`, `import`, `github`, `pr`, `acp`,
server/web и debug verbs отсутствуют в production allowlist. Installer/validator и
benchmark имеют отдельные более узкие internal allowlists; arbitrary forwarding
никогда не используется.

`profile/lsp-safe-servers.json` — pack-owned allowlist pinned V1.17.9 server IDs,
для которых native implementation использует только заранее установленный PATH
binary и не вызывает `Npm.which`, Global cache, installer или `latest` download.
Conditional policy может выбрать только эти IDs и фиксирует canonical binary/version/
SHA; остальные built-ins всегда получают `{ "disabled": true }`.

`profile/policy.json` — единственный machine-readable project policy со strict
schema и `policy_version`. Он содержит только дополнительные relative secret paths,
exact hidden search allow-roots, optional LSP profile с exact audited server IDs и
canonical preinstalled binary/version/SHA-256, а также per-role exact verification
command allowlists, а также bounded per-role LLM calls, root Task calls и compaction
counts. `instruction_files` содержит только explicitly adopted relative auto-
instruction origins и expected SHA/size; remote/secret/control origins запрещены.
Optional `project_skills` содержит только adopted logical name, canonical
relative `SKILL.md`, exact allowed agents и expected SHA-256; он не принимает URLs,
resources или arbitrary discovery paths. `provider_env_names` и `project_env_names`
— non-secret exact-name allowlists;
values никогда не попадают в policy/lock/logs. Имена обязаны соответствовать
`[A-Z][A-Z0-9_]{0,63}`, не могут начинаться с `OPENCODE_`/`OC_MODEL_` и не могут быть
process-loader/shell variables (`LD_*`, `DYLD_*`, `NODE_OPTIONS`, `BUN_OPTIONS`,
`PYTHONPATH`, `PYTHONSTARTUP`, `RUBYOPT`, `PERL5OPT`, `JAVA_TOOL_OPTIONS`,
`_JAVA_OPTIONS`, `NPM_CONFIG_*`, `GIT_CONFIG_*`, `BASH_ENV`, `ENV`, `SHELLOPTS`,
`CDPATH`, `IFS`, `PROMPT_COMMAND` и versioned validator denylist). Generic readers,
interpreters, command substitutions и shell
control operators запрещены schema/semantic validator; fixed audited interpreter +
script invocation может быть отдельным exact entry. Guard читает policy напрямую
через filesystem API до изменения config; missing, invalid или contract-incompatible
policy оставляет base deny-mode. Markdown никогда не парсится как permission source.

Guard создаёт `<managed-runtime-root>/budgets/` только для minimal
append-only counters: root/session IDs, reservation ID, role, event kind и timestamp;
prompts/tool outputs там запрещены. Перед каждым `chat.params`, Task и compaction
guard берёт atomic per-root filesystem lease, append+fsync reservation и лишь затем
разрешает call. Runtime root проходит отдельный containment check относительно
выбранного per-user state base и no-symlink/owner/mode checks; files
открываются exclusive/no-follow там, где это поддерживает platform. Это сериализует
budget reservations даже для parallel children и
нескольких OpenCode-процессов, но не является общим worktree writer lock. Crash после
reservation может только завысить usage; reservation не возвращается автоматически.
Stale lease или corrupt ledger даёт deny до явного recovery через profile doctor.
Runtime root определяется как platform-specific per-user state base плюс SHA-256 от
canonical worktree path и random install UUID из lock; raw path в имени не хранится.
Он обязан находиться вне worktree, принадлежать текущему uid, не иметь symlink
components и не наследовать host OpenCode directories. Runtime ledger user-owned,
не переносится installer и не удаляется автоматически.
Если platform default пересекается с worktree (например, репозиторий охватывает
user-home), managed launch требует явный `OPENCODE_PROFILE_RUNTIME_ROOT` вне обоих
trees и применяет к нему те же owner/mode/canonical checks; небезопасный fallback
внутрь проекта запрещён.
Recovery не зависит от LLM: pack-owned `profile-doctor --audit-budget` выполняет
read-only проверку, а `--recover-budget <root-id> --apply` после проверки отсутствия
живого holder и захвата recovery lease сохраняет исходный ledger/lease в quarantine,
помечает повреждённый root terminal/cap-exhausted и разрешает работу только в новой
root session. Он никогда не обнуляет cap текущего root и ничего не удаляет молча.

### 6.2. Target layout и ownership

В целевом git-репозитории installer создаёт `opencode.jsonc`, `.opencode/*` из
template, копирует canonical validator в
`.opencode/profile/bin/validate-config.sh`, managed launcher и non-LLM profile doctor,
а также создаёт `.opencode/profile-lock.json`.
Lock содержит версию pack, config-contract version, source revision, ownership и
SHA-256 каждого pack-owned файла, а также logical origin registry для agents,
commands, prompts, instructions и skills и random non-secret install UUID для вывода внешнего
runtime path. Он также хранит canonical path/version/SHA-256 registry для OpenCode,
`rg`, materializer npm/runtime, validated shell и benchmark/verification Git, где
они используются pack code. Guard вызывает `rg` только по locked absolute path;
launcher не пере-resolve OpenCode через изменившийся PATH. Сам lock является
installer-owned control artifact и не включает
собственный hash в ownership map.

Installer также генерирует pack-controlled
`.opencode/profile/models.snapshot.json` и
`.opencode/profile/dependencies.manifest.json`. Они не являются hand-edited policy:
первый меняется только model binding transaction, второй — exact dependency
materialization transaction; оба hash-locked и committed/visible для review.

Pack-owned являются PROFILE_RULES, prompts, commands, skills, profile guard,
argv/LSP-safe policies, launcher, profile doctor, generated model/dependency manifests,
`.opencode/package.json`, `package-lock.json`, validator и созданный с нуля
`opencode.jsonc`.
`.opencode/.gitignore`, `profile/policy.json`, `MANIFEST.md`, `INDEX.md`,
`DECISIONS.md` и `STATE.md` являются seed files: installer создаёт отсутствующие,
но сразу помечает user-owned, не
включает их hashes в update ownership и никогда не перезаписывает. Lock хранит их
observed hashes и schema/contract versions только для drift detection. Существующие
policy/Notebook сохраняются и проходят strict schema validation. Корневой
`AGENTS.md`, adopted root config и любые другие файлы вне pack-owned map также
user-owned.

Generic правила pack находятся в `.opencode/PROFILE_RULES.md` и подключаются через
`instructions` в `opencode.jsonc`. Поэтому существующий `AGENTS.md` не копируется и
не перезаписывается. Project facts остаются в user-owned `AGENTS.md` и/или в
`MANIFEST.md`.

Pack command names являются reserved. Managed profile не объединяет их с host или
неучтёнными project commands: launcher/guard требуют exact origin registry и hashes,
а guard final assignment заменяет effective command map целиком. То же правило
применяется к exact agent definitions и всем `{file:}` prompt/instruction refs.

### 6.3. Нормативный контракт installer

1. `install-profile.sh <target>` по умолчанию выполняет только dry-run. Запись
   разрешена лишь с `--apply`.
2. Target должен быть git-репозиторием с чистым worktree. Иначе installer завершает
   работу без изменений; обход проверки требует отдельной будущей функции, не
   скрытого flag.
3. Installer сначала строит полный staging tree и transaction manifest: pre-image
   hashes, создаваемые paths, заменяемые paths и прежний lock. Ни один target path не
   меняется до успешных staging validation и smoke tests.
4. Fresh install создаёт только отсутствующие pack paths. Любое совпадение с
   user-owned не-seed файлом является conflict и останавливает транзакцию.
   `.opencode/.gitignore`, policy и Notebook seed paths являются исключением:
   существующие сохраняются и валидируются, отсутствующие создаются user-owned из
   консервативного template. Gitignore обязан содержать required runtime-artifact
   entry `node_modules/` и не должен игнорировать
   package/lock/guard либо иной
   pack-owned path; исправление требует явного adopted candidate.
5. Если ровно один из `opencode.jsonc`/`opencode.json` уже существует, dry-run
   сохраняет его path/format и выводит merge plan с candidate во временный каталог
   без изменения target. Наличие обоих файлов — conflict до явного решения
   пользователя. Пользователь передаёт итоговый файл через
   `--adopt-config <path> --apply`; installer помещает его и все остальные runtime
   files в один staging tree, проверяет resolved references и применяет одной
   транзакцией. Adopted config записывается в lock как `ownership: user` с observed
   hash и config-contract version.
6. При update новый config-contract сравнивается с lock. Pack-owned config обновляется
   только при совпадении текущего hash. Для adopted config изменение контракта всегда
   останавливает update и создаёт новый candidate; `--re-adopt-config <path> --apply`
   валидирует и применяет merged config вместе со всеми pack updates одной
   транзакцией. Если контракт не менялся, user config только валидируется и его
   observed hash обновляется в lock. Изменение policy-contract аналогично требует
   валидного `--re-adopt-policy <path> --apply`; policy никогда не переписывается
   молча. Provider env name добавляется/удаляется только явными
   `--allow-provider-env <NAME> --apply` / `--remove-provider-env <NAME> --apply`:
   dry-run показывает policy candidate и non-secret lock diff, значение не читается
   и не сохраняется installer. Launcher позднее копирует только exact listed key и
   только если runtime value непустое; wildcard/prefix passthrough запрещён. Для
   non-secret build/toolchain passthrough симметрично используются
   `--allow-project-env`/`--remove-project-env`; тот же dangerous-name denylist
   обязателен. Изменение canonical pack executable path/version/hash требует
   `--rebind-runtime-tools --apply`, full validation и не принимается launcher молча.
   Existing root `AGENTS.md` является единственным implicit user instruction origin:
   install dry-run показывает его hash/size и provider-visible status. Любой nested
   `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md` или иной configured instruction требует
   `--adopt-instruction <relative-path> --apply`; изменение —
   `--re-adopt-instruction`. Source обязан быть existing canonical regular non-symlink
   UTF-8 file, пройти aggregate prompt budget/secret scan и попасть в
   `policy.instruction_files` + lock. Пересечение с baseline/project secret/control
   path даёт безусловный Fail, а не approval bypass. Adoption явно означает, что
   содержимое будет отправляться provider тем ролям, которым OpenCode его injects.
7. Project-specific skill добавляется только через
   `--adopt-skill <name>=<source-SKILL.md> --agents <exact-role-list> --apply`. Dry-run
   показывает staged copy и точечный `policy.project_skills` candidate. Source должен
   быть одним regular non-symlink UTF-8 Markdown file ≤ 32 KiB, иметь matching strict
   frontmatter, не пересекать reserved names/plugin/tool/command paths и не содержать
   secrets. Resources/scripts в V1 project-skill adoption не поддерживаются: skill
   обязан быть self-contained. Apply атомарно
   копирует skill, обновляет exact role skill maps, policy и lock origin registry.
   Изменение требует `--re-adopt-skill` с теми же проверками; collision или drift
   останавливает всю транзакцию. При uninstall adopted skill по умолчанию сохраняется
   как user-owned project skill; uninstall report предупреждает, что обычный OpenCode
   может продолжить auto-discovery. Удаление его файлов требует
   отдельного exact `--remove-adopted-skill <name> --apply` и dependency audit.
8. Остальные updates заменяют только pack-owned файл, чей текущий hash равен hash из
   lock. Modified, missing и colliding paths дают conflict report; частичное
   обновление запрещено.
9. `--uninstall` сначала строит полный retained-reference closure. Если adopted,
   user-owned или modified root config/instruction продолжает ссылаться на pack
   plugin, prompts, commands, skills или другие удаляемые paths, операция без изменений
   завершается conflict. Installer выдаёт de-adoption candidate; пользователь явно
   передаёт проверенный итог через `--adopt-uninstall-config <path> --apply`. Candidate,
   удаления и lock входят в одну rollback-able транзакцию и проверяются на sanitized
   post-uninstall tree до первой записи. Неизменённый pack-owned root config удаляется;
   retained config допускается только если dependency audit доказывает отсутствие
   pack refs и reserved profile stanzas. Затем удаляются только неизменённые
   pack-owned файлы. Seed, изменённые и user-owned файлы сохраняются и перечисляются.
   Policy автоматически не удаляется. После успешного удаления валидный unmodified
   installer lock удаляется как последний control artifact; modified или malformed
   lock останавливает uninstall до удаления любых paths и сохраняется с conflict report.
10. После записи итоговые hashes сверяются, а validation/smoke tests повторяются на
   минимальной sanitized reconstruction из transaction manifest, config refs и
   synthetic fixture, а не на копии всего target. Baseline/policy secret paths,
   unrelated ignored/untracked data и остальные project files не копируются. При
   ошибке rollback восстанавливает все
   pre-images, удаляет каждый path, созданный этой транзакцией, удаляет ставшие
   пустыми созданные directories и восстанавливает либо удаляет lock. Targets берутся
   только из transaction manifest; broad recursive delete запрещён. Fresh-install
   rollback fixture обязан подтвердить byte-for-byte исходный tree.
11. Installer не изменяет global config и не устанавливает OpenCode или providers.
    Temporary roots создаются с mode `0700`, известные secrets исключаются, cleanup
    выполняется при success/error/signal, а logs не содержат copied content. Git
    остаётся дополнительным recovery механизмом, но не заменяет transactional rollback.

До любого вызова OpenCode installer и перед каждым managed launch выполняют
non-executing static preflight всех project, host, system-managed и isolated-auth
config sources. Core profile отклоняет
любые external plugin specs кроме pack guard, auto-discovered `{plugin,plugins}/*`,
remote instructions, auto-discovered executable `{tool,tools}/*.{js,ts}`, любой
непустой effective `mcp` entry — local или remote, `skills.paths`, `skills.urls`,
foreign/duplicate agent, skill (кроме attested denied built-in exception) и command origins, `lsp.*.command`,
`formatter.*.command` и иные process integrations, а также абсолютные, `~/` и
выходящие за copied root `{file:...}` refs. Reserved commands и все разрешённые
skills/prompts обязаны иметь canonical origin и SHA-256, совпадающие с lock;
foreign commands в core не допускаются вовсе. Любой реальный system-managed config,
macOS MDM plist, stored `wellknown` auth или active account/org remote config также
даёт Fail; checker читает только schema/type/origin metadata и никогда не логирует
credential values.

Preflight отдельно воспроизводит V1.17.9 auto-instruction discovery для root/nested
`AGENTS.md`, `CLAUDE.md`, `CONTEXT.md` и configured `instructions`. Разрешены только
pack `PROFILE_RULES.md`, observed root `AGENTS.md` и exact adopted origins; каждый
path canonical/regular/non-symlink, hash/size совпадает, aggregate context budget
проходит. Secret/control overlap блокирует launch до чтения content. Эти файлы
являются намеренно provider-visible system context и не защищаются `read` permission.
Разрешённые relative file refs сначала canonicalize, проверяются на containment и
копируются в тот же disposable tree. Только sanitized plugin-free global copy плюс
hash-verified pack guard допускаются к `opencode debug config`; чужой JavaScript
никогда не импортируется для «проверки».

После static preflight команды OpenCode внутри installer/validator и production
OpenCode внутри launcher работают в изолированном процессе: отдельные
`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`,
`OPENCODE_TEST_HOME` и sanitized config tree. Installer/validator используют temporary
roots и минимальную reconstruction; launcher — persistent owner-only roots вне
worktree, чтобы
сохранять sessions/cache/auth без чтения host OpenCode state. Inherited
environment не наследуется целиком. Launcher строит его заново из фиксированного
validated OS baseline (`PATH`, canonical `USER`/`LOGNAME`, locale/terminal/temp и
validated shell), controlled XDG roots и `HOME` внутри owner-only managed runtime,
exact `OC_MODEL_*`, exact policy
`provider_env_names`/`project_env_names` и probe keys. Переменные с prefix
`OPENCODE_` сначала удаляются все без исключения, после чего launcher выставляет
только перечисленные controlled isolation/catalog variables и optional audited LSP
flag.
Это исключает, в частности, auto-share, disable-autocompact/prune, DB, model
path/URL, config/content/plugin и experimental overrides. `OC_MODEL_*` и
provider/project keys не относятся к этому namespace, но неизвестный inherited key
не передаётся. Credential values не логируются; shell-capable role после explicit
command approval остаётся residual confidentiality boundary §5.2. Shipped JSONC уже
содержит `$schema`. Launcher принудительно задаёт `npm_config_ignore_scripts=true`;
остальные inherited npm/Node/Bun loader options не проходят baseline.
Host home dotfiles, credential chains и `~/.opencode` поэтому не видны process;
filesystem-based provider auth требует отдельного explicit conditional profile.
Это изолирует обычные записи V1.17.9 config loader, который может создавать global config,
`.gitignore` и dependency artifacts. Ни `opencode debug config`, ни discovery/smoke
команды не запускаются непосредственно против реального global config или target.
XDG/temp isolation не называется sandbox для произвольного plugin code; доверенным
исполняемым кодом остаётся только проверенный pack guard. Настоящая проверка чужого
plugin потребовала бы OS sandbox и не входит в core.

Locked plugin dependency сначала разрешается и проверяется config loader в
disposable tree. `.opencode/node_modules/` является ignored runtime artifact и не
pack-owned; package/lock и generated `dependencies.manifest.json` pack-owned/hash
controlled. Materializer в `0700` staging устанавливает exact lock с controlled
runtime `HOME`, empty owner-only `npm_config_userconfig` и
`npm_config_globalconfig`, `npm_config_ignore_scripts=true`, audit/fund/notifier off
и exact `npm_config_registry`, без inherited proxy/auth/cafile variables. Core lock разрешает только HTTPS
tarballs exact audited public registry host с integrity; `git`, `file`, workspace,
plain HTTP, redirect на иной host и arbitrary resolved URL запрещены. Materializer
запрещает symlinks и lifecycle scripts, затем
фиксирует полный sorted tree manifest: relative path, type, mode, size и SHA-256
каждого regular file. Только после проверки он атомарно меняет runtime tree, сохраняя
предыдущий в quarantine.

Перед каждым OpenCode process launcher под cooperative lease сверяет отсутствие
missing/extra/symlink entries и весь manifest; только потом допускает pre-guard import.
Mismatch или недоступный exact artifact останавливает launch без OpenCode и предлагает
non-LLM `profile-doctor --materialize-deps --apply`; версия не подменяется, старый tree
не удаляется молча. Это обязательно, потому что V1.17.9 при существующем
`node_modules` не проверяет extracted file contents по lock integrity.

Validator делает два resolved-config audit: чистый pack и отрицательный fixture с
предварительно sanitized hostile global config. Второй доказывает, что launcher не
наследует host agents/permissions/MCP/commands/skills; любой foreign executable или
origin collision уже даёт Fail на static preflight. После установки managed запуск
может создавать runtime cache artifacts; dependency tree остаётся exact-manifest
runtime artifact и повторно проверяется на следующем launch.
Платные provider smoke calls выполняются только отдельной явной командой, с показом
ожидаемого числа вызовов.

`profiles/models.env.example` — документация переменных, а не автоматически
загружаемый env-файл. Пользователь экспортирует значения через shell/direnv либо
явно подключает свой wrapper; реальные значения не коммитятся. Installer и validator
завершаются с ошибкой, если обязательная binding-переменная отсутствует.

## 7. Постоянный контекст

### 7.1. `AGENTS.md`

User-owned root `AGENTS.md` загружается вне tool permissions и отправляется provider
как system context, поэтому в нём разрешены только non-secret project instructions:
только:

- краткие инварианты безопасности;
- неочевидные project-wide conventions;
- ссылку на canonical `MANIFEST.md` и условные skills без автоматического чтения
  всех файлов.

Canonical executable verification allowlists, secret paths и search roots хранятся
в `profile/policy.json`; `MANIFEST.md` даёт человеку краткую карту и ссылку на них.
`AGENTS.md` не дублирует эти списки.

Целевой размер `AGENTS.md` — до 2 000 символов, максимум без явного waiver — 4 000.
Большие style guides и справочники запрещено подключать широкими instruction globs.
Nested/legacy instruction files без exact adoption запрещены; изменение adopted hash
требует re-adoption перед managed launch.

### 7.2. Notebook

Notebook — компактное состояние проекта, а не архив сессий.

`MANIFEST.md` содержит:

- цель и границы проекта;
- стек и структуру;
- назначение canonical commands/protected paths из `profile/policy.json`;
- ключевые термины.

`INDEX.md` содержит:

- карту модулей и ключевые entry points;
- маршрутизационные ключевые слова;
- ссылки на релевантные разделы Decisions;
- дату или revision последней проверки.

`DECISIONS.md` хранит ADR со следующими полями:

- ID и дата;
- статус `proposed | accepted | superseded | rejected`;
- контекст;
- решение;
- последствия и rollback;
- `supersedes` или `superseded_by`;
- evidence/reference.

`STATE.md` хранит только актуальное проверенное состояние:

- milestone и active task;
- base branch/revision;
- подтверждённо завершённое;
- изменённые файлы;
- выполненные проверки и их результаты;
- риски и blockers;
- конкретный следующий шаг;
- ID и время последнего checkpoint.

В Notebook запрещены transcript, raw tool outputs, секреты и неподтверждённые
предположения. Завершённая история остаётся в git и OpenCode sessions. STATE должен
оставаться кратким; старые решения не удаляются молча, а помечаются `superseded`.

## 8. Ролевые модели

Реальные provider/model IDs не являются частью архитектуры. Установка связывает
следующие capability slots:

| Переменная | Назначение | Минимальные качества |
| --- | --- | --- |
| `OC_MODEL_COORDINATOR` | Orchestrator | надёжный tool use, instruction following, умеренная цена |
| `OC_MODEL_EXPLORER` | Explorer | минимальная цена и задержка при надёжных read/search tools |
| `OC_MODEL_SCOUT` | Scout | поиск, чтение документации, длинный контекст |
| `OC_MODEL_ARCHITECT` | Architect | сильнейшее reasoning, контракты и trade-offs |
| `OC_MODEL_IMPLEMENTER` | Implementer | сильное coding/tool use, точные изменения и тесты |
| `OC_MODEL_REVIEWER` | Reviewer | независимая критика, поиск дефектов, reasoning |
| `OC_MODEL_COMPACTOR` | `compaction` | faithful summarization, достаточное usable input window, низкая цена |

Несколько slots могут ссылаться на одну модель: это роли качества/стоимости, а не
требование иметь семь разных провайдеров или подписок.

Reviewer желательно назначать из другого model family, чем Implementer, если это
не ухудшает benchmark. Это рекомендация для независимости ошибок, а не требование
к провайдеру.

Каждая модель до включения проходит role smoke tests. Во время explicit install/model
rebind изолированный resolver строит `.opencode/profile/models.snapshot.json` только
для семи slots; dry-run показывает provider/model, bundled adapter ID, exact API URL,
limits, capabilities, pricing и variants без credentials. `--bind-models --apply` или
`--rebind-models --apply` принимает snapshot, чей SHA и значения каждого `OC_MODEL_*`
записываются в lock. Core допускает только bundled providers OpenCode 1.17.9;
nonbundled/custom `api.npm` adapter возможен лишь в отдельном conditional profile с
exact version/integrity/module-manifest audit.

На каждом managed launch выставляются controlled
`OPENCODE_DISABLE_MODELS_FETCH=true` и `OPENCODE_MODELS_PATH` на hash-verified snapshot;
mutable catalog/cache не используется. Launcher до process сверяет семь bindings,
provider/model/API/adapter/limits/capabilities и selected variant с lock. Пустая или
изменённая env-переменная, catalog drift, `latest`, arbitrary npm/API override или
неизвестные limits дают Fail без network/fallback. Resolved-profile audit также
фиксирует reasoning options, temperature/top_p и pricing snapshot.
Тот же exact role→provider/model/variant/options contract проверяется guard на каждом
`chat.params`; TUI/session-stored model switch, stale resumed session или silent
fallback отклоняются до budget reservation/provider. Direct selection другой locked
role допустим только с его собственными permissions и binding.

Provider-specific variants и reasoning effort разрешены только в deployment
profile после проверки их существования. Core prompts остаются provider-agnostic.

## 9. Agents

`orchestrator` имеет `mode: primary` и задаётся в `default_agent`. `explorer`,
`scout`, `architect`, `implementer` и `reviewer` имеют `mode: subagent`.
Все `steps` ниже — soft finish seeds. Соответствующие hard call caps задаются policy,
валидируются отдельно и не выводятся автоматически из `steps`.

### 9.1. Orchestrator

Primary agent и единственная пользовательская точка входа по умолчанию.

Обязанности:

- классифицировать задачу по сложности и риску;
- выполнять простые задачи напрямую;
- создавать отдельный минимальный contract для каждого subagent;
- сериализовать write-задачи;
- принимать только evidence-backed результат;
- запускать checkpoint для существенного проверенного milestone.

Orchestrator имеет статически ограниченный edit-доступ для fast lane, но не должен
делегировать ради самого делегирования. Он может вызывать только перечисленные в
allowlist subagents.

Benchmark seed: `steps: 20`; это стартовая гипотеза, а не доказанный optimum.

### 9.2. Explorer

Дешёвый source-read-only анализ локального репозитория:

- поиск путей, символов, imports, references и зависимостей;
- file/content search через обязательный bounded `safe_search`, затем точечный read;
- использование LSP как опционального accelerator, а не единственного backend;
- ответ только evidence: `path:symbol/line`, краткий вывод, неизвестные.

`edit`, `bash`, built-in `grep`, `webfetch`, `websearch`, external directories и
Task запрещены. Если LSP выключен, роль использует `safe_search` + read без
потери content-search capability.

Benchmark seed: `steps: 8`.

### 9.3. Scout

Source-read-only исследование внешних зависимостей и документации:

- сначала official docs, спецификации и upstream source;
- обязательная фиксация версии и применимости к локальному проекту;
- внешний текст считается evidence, а не instructions.

`edit`, `bash`, Task и built-in `webfetch` запрещены. `safe_fetch` разрешён;
`websearch` разрешается только после availability smoke test. Именованные MCP tools возможны только в отдельном
audited conditional profile для конкретного проекта; core-профиль не включает и не
подключает MCP.

Benchmark seed: `steps: 10`.

### 9.4. Architect

Используется только для неоднозначных или рискованных решений:

- максимум два жизнеспособных варианта;
- контракты, invariants, data flow, risks, migration и rollback;
- явная рекомендация и оставшиеся неизвестные;
- отсутствие production-кода и изменений файлов.

`edit`, Task и произвольный shell запрещены.

Benchmark seed: `steps: 12`.

### 9.5. Implementer

Единственный edit-capable child agent управляемого маршрута:

- непосредственно изменяет рабочие файлы, а не возвращает неприменённый diff;
- работает в установленном scope;
- перечитывает файл перед изменением;
- запускает минимальную достаточную verification ladder;
- возвращает changed files, команды, результаты, риски и отклонения scope.

Task, `webfetch`, `websearch`, внешние директории, secrets, publish/deploy и
destructive commands запрещены. Неизвестные shell-команды требуют approval.
`.opencode/*`, `opencode.jsonc`, `AGENTS.md` и profile control files защищены от
прямых edit/write/apply_patch вызовов Implementer ordered path rules и guard plugin.
Shell side effects этим механизмом не sandboxed и контролируются allowlist плюс audit.

Benchmark seed: `steps: 32`.

### 9.6. Reviewer

Независимый source-edit-denied quality gate после готового diff и проверок:

- проверяет Definition of Done, Key Decisions и фактический diff;
- сообщает findings с severity и `file:line` evidence;
- различает Blocker, Major, Minor, Note и residual risk;
- возвращает только `Pass` или `Fail` с обоснованием;
- не исправляет найденные проблемы.

`edit` и Task запрещены. Shell ограничен точными hardened Git argv: locked binary,
`--no-pager`, `-c core.fsmonitor=false`, `-c diff.external=`, для diff также
`--no-ext-diff --no-textconv --ignore-submodules=all`, controlled
`GIT_OPTIONAL_LOCKS=0`; generic `git diff`/`git status` не allowlisted. Остальное —
утверждённые в `profile/policy.json` verification commands. До и после review фиксируется
worktree state. Новое изменение tracked source является Fail; новые build artifacts
перечисляются и не удаляются автоматически.

Benchmark seed: `steps: 12`.

### 9.7. Maintenance agents

В committed base config `orchestrator`, пять child roles, `compaction`, `title`,
`summary`, `build`, `general`, `explore` и `plan` имеют `disable: true`. Только
успешный final guard assignment включает intended six roles и `compaction`.
Built-in `title` и после activation нормативно имеет `disable: true`: автоматические названия сессий не
оправдывают отдельный LLM call. Hidden `summary` в V1.17.9 runtime не вызывается и не
настраивается. `compaction` использует `OC_MODEL_COMPACTOR`, не получает рабочие
tools и проходит отдельный resume-fidelity benchmark.

Все альтернативные selectable built-ins — `build`, `general`, `explore` и `plan` —
нормативно имеют `disable: true`. Это исключает обход Orchestrator через прямой вызов
этих built-ins. Validator перечисляет каждый effective agent и отклоняет неизвестную
primary/subagent роль или роль с более широкими permissions.

## 10. Permissions matrix

Таблица ниже — intended effective permissions после успешного guard `config` hook.
В committed base config root и каждая роль начинаются с `"*": "deny"`; guard строит
карты локально, проверяет contract/hash и присваивает их config только последней
операцией. Частично активированного состояния быть не должно.

| Capability | Orchestrator | Explorer | Scout | Architect | Implementer | Reviewer |
| --- | --- | --- | --- | --- | --- | --- |
| read (regular file only) | allow | allow | allow | allow | allow | allow |
| glob | deny | deny | deny | deny | deny | deny |
| grep | deny | deny | deny | deny | deny | deny |
| safe_search | allow | allow | deny | allow | allow | allow |
| LSP tool | optional | optional | deny | optional | optional | optional |
| automatic formatter | false | false | false | false | false | false |
| edit | static project allow | deny | deny | deny | static project allow | deny |
| bash | project allowlist/ask | deny | deny | deny | project allowlist/ask | diff/verify allowlist |
| webfetch | deny | deny | deny | deny | deny | deny |
| safe_fetch | deny | deny | allow | deny | deny | deny |
| websearch | deny/delegate | deny | conditional allow | deny | deny | deny |
| MCP tools | deny | deny | deny; separate audited profile only | deny | deny | deny |
| Task | exact role allowlist | deny | deny | deny | deny | deny |
| external directory | deny | deny | deny | deny | deny | deny |
| Notebook paths | allow by path; checkpoint-only is policy | deny | deny | deny | deny | deny |

Общие правила:

- baseline secret globs включают `*.env`, `*.env.*` и root+nested pairs: `.env` +
  `*/.env`, `.env.*` + `*/.env.*`, `id_rsa*` + `*/id_rsa*`, `id_ed25519*` + `*/id_ed25519*`, `.npmrc` +
  `*/.npmrc`, `.pypirc` + `*/.pypirc`, `credentials.json` +
  `*/credentials.json`, а также `*.pem` и `*.key`; Orchestrator получает
  `read: ask`, child roles — `deny`,
  edit запрещён всем ролям; `.env.example`/`.env.sample` явно разрешены;
- `profile/policy.json` может добавлять project-specific secret paths, но не ослаблять baseline
  без явного пользовательского scope;
- каждый существующий secret-matching path, кроме явно разрешённых examples, должен
  быть подтверждён `git check-ignore`; tracked/unignored path блокирует установку до
  явной reclassification;
- `git push`, publish, deploy, destructive filesystem/database operations запрещены
  или требуют явного approval;
- любой MCP в core запрещён; conditional profile использует exact server/tool allowlist;
- direct `@agent` invocation не должна давать роли больше прав, чем Task invocation;
- permission `deny` важнее prompt-инструкции.

`safe_search` имеет собственный exact permission key. Он разрешён только ролям из
матрицы, принимает `mode: "files" | "content"`, regex/literal для content mode, до
восьми validated relative roots и optional file globs. Files mode возвращает только
разрешённые relative paths; content mode — structured matches. Общий output не более
200 matches/paths, 500 lines и 32 768 bytes. Hard limits:
20 000 candidates, 4 MiB суммарных candidate-path bytes и 10 s wall time на весь
call. Enumeration использует NUL-delimited paths; files mode возвращает bounded
filtered candidate list, а content results — structured JSON. Только в content mode
разрешённые files передаются `rg` без shell batches максимум по 256 paths и 64 KiB
argv, только после `--`; timeout/abort завершает child process. Сначала tool
строит candidate list без model-supplied globs, с ignore/hidden/symlink policy;
затем canonicalizes и фильтрует каждый candidate по immutable deny rules. Только
после этого model file globs применяются в памяти, а `rg` получает явный bounded
список уже разрешённых файлов. Это важно: положительный `rg --glob` способен
переопределить `.gitignore`. Model input никогда не попадает в traversal flags или
safety excludes. Hidden root допускается только как exact project allow-root из
`profile/policy.json` после тех же canonical/secret checks; модель не может включить `--hidden`.
Truncation, timeout, candidate cap и skipped roots указываются в metadata;
unlimited output и silent fallback к built-in `grep`/`glob` запрещены.
Custom-tool registration сама по себе permission не применяет. Поэтому первой
операцией `execute` — до path resolution, enumeration и spawn — является role lookup
по `sessionID` и `ctx.ask({ permission: "safe_search", patterns: ["*"], ... })`;
ошибка lookup, deny или ask без approval завершает call без side effect. Guard
`tool.execute.before` независимо проверяет ту же exact role allowlist.

`safe_fetch` имеет отдельный exact permission key и доступен только Scout. До DNS
он выполняет тот же `sessionID` role lookup + `ctx.ask`; unknown/denied role не делает
network call. URL обязан быть HTTPS, port 443, без userinfo/IP literal; canonical
IDNA host не может быть localhost, local/internal/special-use name. Все A/AAAA
addresses проверяются на global-unicast: loopback, private, link-local, multicast,
CGNAT, IPv4-mapped и прочие special-use/metadata ranges запрещены. Соединение
прикрепляется к одному из уже проверенных addresses с TLS SNI и certificate check
исходного host, а не выполняет новый неконтролируемый resolve.

Разрешены максимум три HTTPS redirects; каждый hop заново проходит URL/DNS/address
validation, downgrade запрещён. Tool игнорирует proxy env, не отправляет cookies,
authorization или user headers и использует fixed User-Agent/Accept. Общий timeout
15 s, compressed и decompressed body caps по 2 MiB, только allowlisted textual MIME;
model output ≤ 32 768 bytes/500 lines с truncation metadata. Abort закрывает socket.
External body маркируется как untrusted evidence. Built-in `webfetch` не используется;
hard network sandbox/transparent proxy control вне process остаётся ограничением OS.

`formatter: false` является invariant и до, и после guard activation. Guard тем же
atomic commit заменяет merged `config.mcp` на `{}`; per-launch preflight не допускает
ни local, ни remote MCP. Это необходимо, потому что V1.17.9 eager-connect выполняется
до фильтрации MCP tool permissions. V1.17.9
запускает configured formatter subprocess после edit вне `bash` permission; поэтому
автоформатирование не является безопасным extension point core-профиля. Нужная
format/check команда указывается exact entry в `profile/policy.json`, запускается
явно и попадает в pre/post audit. Custom `lsp.*.command` запрещён; optional LSP
допускает только отдельно проверенный preinstalled built-in server profile при
`OPENCODE_DISABLE_LSP_DOWNLOAD=true` и не является secret
boundary. MCP process/connection в core отсутствует.

Для каждой intended agent ruleset guard добавляет explicit `external_directory`
`deny` с pattern, в точности равным runtime
`path.join(Global.Path.data, "tool-output", "*")`. Generic `deny`/`"*"` недостаточен:
V1.17.9 иначе автоматически дописывает allow для Truncate.GLOB. Guard вычисляет
resolved pattern при config hook; validator проверяет final rule и фактический deny.
В missing-guard base mode возможный runtime-added external allow остаётся инертным,
поскольку root/per-role wildcard запрещает сам `read` tool.

`permission.task` Orchestrator разрешает только `explorer`, `scout`, `architect`,
`implementer` и `reviewer`; wildcard fallback — `deny`. У всех пяти subagents
`task: deny`.

OpenCode применяет последнее совпавшее правило, а `*` в permission pattern может
пересекать path separators. Поэтому config generator обязан эмитировать ordered
maps именно в следующем порядке:

```text
READ Orchestrator
  *                              allow
  .opencode/*                    ask
  .opencode/notebook/MANIFEST.md allow
  .opencode/notebook/INDEX.md    allow
  .opencode/notebook/DECISIONS.md allow
  .opencode/notebook/STATE.md    allow
  *.env                          ASK_SECRET
  *.env.*                        ASK_SECRET
  .env                           ASK_SECRET
  */.env                         ASK_SECRET
  .env.*                         ASK_SECRET
  */.env.*                       ASK_SECRET
  *.pem                          ASK_SECRET
  *.key                          ASK_SECRET
  id_rsa*                        ASK_SECRET
  */id_rsa*                      ASK_SECRET
  id_ed25519*                    ASK_SECRET
  */id_ed25519*                  ASK_SECRET
  .npmrc                         ASK_SECRET
  */.npmrc                       ASK_SECRET
  .pypirc                        ASK_SECRET
  */.pypirc                      ASK_SECRET
  credentials.json               ASK_SECRET
  */credentials.json             ASK_SECRET
  *.env.example                  allow
  *.env.sample                   allow
  .opencode/node_modules/*       deny
  .opencode/profile-lock.json    deny
  .git                           deny
  .git/*                         deny
  AGENTS.md                      ask
  opencode.json                  ask
  opencode.jsonc                 ask
  <project-specific secrets>     ASK_SECRET

READ child roles
  *                              allow
  <baseline secret globs>        deny
  *.env.example                  allow
  *.env.sample                   allow
  AGENTS.md                      deny
  opencode.json                  deny
  opencode.jsonc                 deny
  .git                           deny
  .git/*                         deny
  .opencode/*                    deny
  <project-specific secrets>     deny

EDIT Orchestrator
  *                              allow
  <baseline secret globs>        deny
  *.env.example                  allow
  *.env.sample                   allow
  .opencode/*                    ask
  .opencode/notebook/MANIFEST.md allow
  .opencode/notebook/INDEX.md    allow
  .opencode/notebook/DECISIONS.md allow
  .opencode/notebook/STATE.md    allow
  .opencode/node_modules/*       deny
  .opencode/profile-lock.json    deny
  AGENTS.md                      ask
  opencode.json                  ask
  opencode.jsonc                 ask
  .git                           deny
  .git/*                         deny
  <project-specific secrets>     deny

EDIT Implementer
  *                              allow
  <baseline secret globs>        deny
  *.env.example                  allow
  *.env.sample                   allow
  AGENTS.md                      deny
  opencode.json                  deny
  opencode.jsonc                 deny
  .opencode/*                    deny
  .git                           deny
  .git/*                         deny
  <project-specific secrets>     deny
```

У остальных ролей `edit: deny` без исключений. `ASK_SECRET` означает `ask` только
для Orchestrator. Project-specific secret rules всегда эмитируются последними и не
могут быть ослаблены Notebook/control/example allow. Если такой path делает
обязательный profile artifact недоступным, validator требует явной reclassification
и не запускает частично рабочий профиль.

Task и skill maps также строго ordered: первым идёт `"*": "deny"`, затем exact
`"<allowed-name>": "allow"`. Для Orchestrator разрешены ровно пять Task names выше.
Для каждого agent разрешены ровно skills из §13.3; отсутствие exact match всегда
даёт deny; final exact `customize-opencode: deny` фиксирует built-in exception. Name
allowlist не является origin check: guard до atomic activation
сверяет каждый allowed skill с canonical origin/SHA из lock, отвергает duplicates и
запрещает activation при любом расхождении.

Overlap probes обязательны для `.opencode/profile-lock.json`,
`<managed-runtime-root>/budgets/canary`,
`.opencode/notebook/.env`, root/nested `prod.env`, `.env.example`, `AGENTS.md`,
`opencode.json`, `opencode.jsonc`, неизвестного Task и неизвестного skill.
Built-in `grep` полностью запрещён и schema-hidden: в V1.17.9 его permission матчит regex запроса, а не
file path, после чего ripgrep ищет включая hidden files; `read` deny его не защищает.
Built-in `glob` также полностью запрещён и schema-hidden: permission матчит model pattern, а не `path`, и
положительный glob способен вернуть ignored/hidden filenames. File discovery идёт
через bounded `safe_search mode=files` с теми же immutable path/secret denies.
Автоматические bash allowlists не включают `rg`, `grep`, `cat`, `sed`, `awk`,
`head`, `tail`, shell/interpreter launchers или другие generic file-read bypasses.
Unknown shell остаётся `ask`, поэтому явно одобренный пользователем command уже не
является hard security boundary.

Все path maps в этом разделе управляют только соответствующими OpenCode tools.
Guard дополнительно проверяет canonical path arguments для `read`, `write`, `edit`,
`apply_patch` и `lsp.filePath`, запрещает symlink components и
`*** Move to:`. Это закрывает
известные lexical/move bypasses в нормальном single-process execution; межпроцессный
symlink race остаётся ограничением §5.2. `edit`/`read` и `external_directory` не
sandbox дочернего shell process: даже
allowlisted build/test script способен читать или менять другие paths. Поэтому для
shell-capable Orchestrator, Implementer и Reviewer применяются exact command
allowlists, pre/post tracked+untracked worktree audit и явный residual-risk report;
hard isolation требует внешнего sandbox и не заявляется core-профилем.
Для `read` guard после canonicalization выполняет no-follow stat и отклоняет directory,
missing target и non-regular file до built-in enumeration/`Did you mean`. Это
предотвращает раскрытие secret/control filenames через разрешённый parent;
directory/file/typo discovery доступен только через bounded `safe_search mode=files`.

Условие «Notebook только во время checkpoint» и текущий `Relevant_Files` невозможно
выразить статической permission; это prompt-policy плюс post-diff audit.

Core base и normal guard output всегда имеют `lsp: false`: experimental tool flag не
управляет LSP lifecycle, а read/edit могут запускать server независимо. Conditional
LSP profile допускается только после preflight: launcher принудительно сохраняет
`OPENCODE_DISABLE_LSP_DOWNLOAD=true`; guard final assignment создаёт exact map с
`{disabled:true}` для каждого non-selected built-in ID и OMIT selected IDs, чтобы
использовать только их native definitions. Selected ID обязан присутствовать в
pack-owned `lsp-safe-servers.json`, уже установленный PATH executable и его canonical
path/version/SHA-256 совпадают с policy/lock. Built-ins, использующие `Npm.which`,
Global cache или installer (включая соответствующие TS/Biome paths), не входят в
allowlist даже при заполненном cache. `lsp: true`, explicit custom command,
auto-install, `latest`, unknown ID и silent download запрещены. Только после этого optional
`OPENCODE_EXPERIMENTAL_LSP_TOOL=true` открывает model tool. Без conditional profile
prompts не упоминают LSP и используют `safe_search` + read.

## 11. Маршрутизация

Orchestrator содержит короткий always-on classifier. Полный `task-context` skill
загружается только для нетривиального делегирования.

### Tier 0 — ответ или локальное чтение

Признаки: нет изменений, известный scope, низкий риск.

Маршрут: Orchestrator отвечает напрямую или вызывает одного Explorer/Scout только
при реальной неизвестности. Checkpoint не нужен.

### Tier 1 — простая локальная правка

Признаки: понятное решение, обычно 1–2 файла, нет public contract, migration,
security или persistence риска.

Маршрут: Orchestrator изменяет напрямую, запускает targeted verification и кратко
отчитывается. Reviewer необязателен. Checkpoint создаётся только для существенного
milestone.

### Tier 2 — управляемая реализация

Признаки: несколько файлов, неизвестный impact, новый behavior или умеренный риск.

Маршрут:

```text
[Explorer] → Implementer → Verification → [Reviewer] → Checkpoint
```

Reviewer обязателен, если изменение влияет на несколько модулей или имеет трудно
обратимые последствия.

### Tier 3 — высокий риск или архитектура

Автоматические триггеры:

- auth, permissions, secrets или cryptography;
- schema/data migration и persistence;
- concurrency и distributed behavior;
- public API или совместимость;
- billing/payments;
- infrastructure, deploy или необратимые операции;
- неоднозначное cross-module решение.

Маршрут:

```text
Explorer || Scout → Architect → Decision Gate
  ├─ covered/approved → Implementer → Verification → Reviewer
  ├─ user decision required → AWAITING_USER
  │    ├─ approved → Implementer
  │    └─ rejected → ABORTED
  └─ impossible/out of scope → BLOCKED
```

Параллельно разрешены только независимые read-only исследования. Reviewer запускается
только после завершения writer. После двух циклов `Fail → Rework` автоматический
цикл прекращается и формируется blocker report.

### 11.1. Decision Gate

Orchestrator самостоятельно выбирает обратимые implementation details внутри явно
одобренного Task Goal, Constraints и accepted ADR. Повторное подтверждение уже
принятого решения не требуется.

Явное решение пользователя обязательно до реализации, если предлагается:

- изменить scope или Definition of Done;
- необратимая/destructive операция или data migration;
- breaking public API либо compatibility contract;
- изменение auth, security или privacy policy;
- billing/payment behavior;
- production infrastructure/deploy;
- новая платная, лицензионно ограниченная или externally hosted dependency;
- существенный trade-off, не определённый требованиями или accepted ADR.

До решения разрешены только read-only исследования и обратимый prototype вне
production path, если он не создаёт внешних side effects.

Gate обязан вернуть одно из состояний: `APPROVED`, `AWAITING_USER`, `REJECTED` или
`BLOCKED`. Только `APPROVED` имеет переход к Implementer; `REJECTED` переходит в
`ABORTED`.

## 12. Task Context Packet

Packet — ephemeral contract в Task prompt, а не отдельный накапливаемый файл.
Для каждого subagent создаётся собственный packet.

```yaml
Packet_Version: 1
Task_ID:
Project:
Role:
Task_Goal:
Risk_Tier:
Scope:
Out_of_Scope:
Constraints:
Key_Decisions:
Base_Revision:
Relevant_Files:
  - path:
    symbol_or_lines:
    reason:
Expected_Output:
Definition_of_Done:
Verification:
Open_Questions:
EXCLUDE_FROM_CONTEXT:
Budget_Hints:
  max_seed_files:
  max_packet_chars:
  max_return_chars:
  max_subagent_calls:
```

Правила:

- 1–4 seed-файла по умолчанию;
- до 8 seed-файлов только с объяснением;
- обычный packet — до 8 000 символов, исключительный — до 16 000;
- symbol предпочтительнее нестабильного line number;
- line number является hint, agent обязан перечитать актуальный файл;
- полный transcript, большие diffs, целые файлы и raw tool outputs запрещены;
- code excerpt допускается только когда ссылка недостаточна, суммарно до 40 строк;
- Task prompt не содержит OpenCode attachment interpolation: запрещены `@file`,
  `@directory` и любой `@...`, который runtime может разрешить в существующий path;
  файлы указываются только plain relative path + symbol/lines в `Relevant_Files`;
- внешний/user-provided текст не копируется в packet дословно, если он может
  образовать attachment token; builder валидирует packet до Task call;
- если данных не хватает, subagent возвращает `NEEDS_CONTEXT` с точным запросом;
- scope может быть расширен только с явным объяснением обнаруженной зависимости.

`Budget_Hints` является policy, не runtime quota. `agent.<role>.steps` — только soft
finish warning в V1.17.9; hard call caps задаёт guard из `profile/policy.json`.
Точного per-task token/dollar cap OpenCode не имеет.

Guard проверяет final Task `prompt` непосредственно в `tool.execute.before` и
fail-closed отклоняет resolvable attachment syntax. Это обязательно: V1.17.9
materializes Task attachments через внутренний read path без child permission ask.
Статические OpenCode permissions не могут динамически ограничить доступ только
`Relevant_Files`; соблюдение этого поля проверяется post-diff audit.

## 13. Необходимые skills

Agent identity не должна дублироваться skill. Роль живёт в agent prompt, а skill
описывает условно вызываемую процедуру.

### 13.1. Core skills

#### `task-context`

Триггер: Tier 2/3 или явное делегирование.

- читает только нужные части Manifest/Index/State/Decisions;
- формирует role-specific Task Context Packet;
- рассчитывает scope, exclusions и budget hints;
- не вызывается для fast lane.

Доступ: только Orchestrator; Architect получает уже собранный packet и не читает Notebook.

#### `verification`

Триггер: любое изменение behavior или кода.

- строит лестницу `targeted → module → full suite`;
- выбирает минимальный достаточный уровень по риску;
- фиксирует точную команду, exit status и краткий результат;
- запрещает объявлять успех без evidence.

Доступ: Orchestrator, Implementer и Reviewer.

#### `checkpoint`

Триггер: проверенный milestone, преднамеренный handoff или длительная пауза.

- требует успешной verification и необходимого Reviewer Pass;
- обновляет STATE;
- при необходимости обновляет INDEX и DECISIONS;
- проверяет запись повторным чтением;
- не требует автоматически выполнять `/new`.

Доступ: только Orchestrator.

#### `debugging`

Триггер: неизвестная причина дефекта или падение проверки.

- `reproduce → isolate → hypotheses → discriminating checks → fix → regression`;
- разделяет диагноз и реализацию;
- не допускает speculative fixes без воспроизведения или evidence.

Доступ: Orchestrator и Implementer.

#### `architecture-decision`

Триггер: Tier 3, новый контракт или durable trade-off.

- максимум два варианта;
- invariants, trade-offs, migration, rollback и recommendation;
- создаёт ADR только после принятия решения;
- связывает superseded decisions.

Architect возвращает ADR candidate в ответе и не пишет Notebook; после принятия
Orchestrator сохраняет его на checkpoint. Доступ: Architect и Orchestrator.

#### `profile-doctor`

Триггер: установка, смена модели, изменение config или обновление OpenCode.

- проверяет exact OpenCode version;
- resolved config и schema;
- model bindings и tool support;
- effective variants, limits, pricing и compaction model;
- locked model snapshot и extracted dependency manifest;
- discovery agents/skills;
- policy schema/semantics, guard loaded/deny-mode state, `safe_search` и effective permissions;
- Notebook schema, aggregate prompt budget и tool-output limits.

Доступ: только Orchestrator для интерпретации отчёта. Canonical проверки и budget
recovery выполняет deterministic non-LLM `.opencode/profile/bin/profile-doctor`;
skill не является recovery dependency.

### 13.2. Conditional skills

#### `dependency-research`

Фиксирует version, official source, локальную применимость и ссылки. Доступен Scout.

#### `security-review`

Подключается только для auth, secrets, permissions, crypto, network boundaries и
untrusted parsing. Доступен Reviewer и Architect.

#### Project-specific skills

Добавляются только после анализа конкретного репозитория: database migration,
public API compatibility, mobile build, deployment и т. п. Большой универсальный
skill «на все случаи» запрещён. Установка выполняется только нормативным
`--adopt-skill ... --agents ...` workflow §6.3; ручное копирование блокирует managed
launch как unknown/collision origin.

### 13.3. Skill allowlists

| Agent | Skills |
| --- | --- |
| Orchestrator | `task-context`, `verification`, `checkpoint`, `debugging`, `architecture-decision`, `profile-doctor` |
| Explorer | none |
| Scout | `dependency-research` |
| Architect | `architecture-decision`, `security-review` |
| Implementer | `verification`, `debugging`, project-specific |
| Reviewer | `verification`, `security-review`, project-specific |

Все остальные skills скрываются через `permission.skill`.
Дополнительно launcher, static preflight и guard связывают каждый exact allowed name
с одним canonical origin и SHA-256 из lock. `OPENCODE_DISABLE_EXTERNAL_SKILLS=true`
подавляет `.claude`/`.agents` discovery, но не считается достаточной защитой без
origin registry и collision scan.
Diff-first review checklist, единая severity `Blocker | Major | Minor | Note` и
Pass/Fail являются частью reviewer prompt. Отдельный `code-review` skill не создаётся:
он не ленивый для этой роли и добавил бы лишний tool call.

## 14. Custom commands

| Command | `agent` | `subtask` | Назначение |
| --- | --- | --- | --- |
| `/route` | `orchestrator` | `false` | повторно маршрутизировать текущую active task |
| `/review` | `reviewer` | `true` | изолированно проверить текущий diff |
| `/diagnose` | `orchestrator` | `false` | выполнить debugging workflow без автоматического fix |
| `/checkpoint` | `orchestrator` | `false` | сохранить подтверждённый milestone |
| `/handoff` | `orchestrator` | `false` | checkpoint, readback STATE и короткий resume prompt |
| `/status` | `orchestrator` | `false` | показать verified status, blockers и next step |

Commands являются ergonomic entry points, а не security boundary. Нельзя
переопределять `/new` или `/compact`. Поле `model` во всех command отсутствует:
команда наследует model выбранного agent. Command не расширяет permissions agent.
Все shipped commands строго zero-argument: templates не содержат `$ARGUMENTS`,
positional placeholders, shell blocks, `@file` или `@directory`. Задача передаётся
обычным user message; commands работают только с текущей active task/diff/state.
Guard отклоняет command с непустым `arguments` в `command.execute.before`, но этот
hook вызывается после native interpolation, поэтому защита является detection, а
не sandbox; README явно запрещает вставлять untrusted text в command arguments.
Reserved command catalog разрешается только из pack-owned canonical origins с hashes
из lock. Host/config-dir commands изолированы launcher, а любой project command вне
registry или collision имени блокирует managed launch до OpenCode process.

V1.17.9 всегда добавляет built-in `/init`, `/review`, built-in skill
`customize-opencode` и slash aliases для всех discovered skills; skill permission не
фильтрует эти aliases, а shell/file interpolation идёт до hook. Поэтому guard final
command map целиком содержит шесть intended commands выше и pack-owned inert
zero-argument shadows для `init`, `customize-opencode` и каждого locked core/project
skill name, кроме names из intended command set. Intended `review` безопасно shadow-ит
built-in, а intended `checkpoint` — одноимённый core-skill alias. Shadows не содержат
arguments, shell или attachments. `command.execute.before` разрешает только шесть
intended names и отклоняет все shadows/unknown names; static audit exact
`Command.list` не допускает иной effective command. Adoption skill с collision
command name запрещён.

## 15. Нормативный workflow

```text
INTAKE
  ↓
TRIAGE
  ├─ Tier 0 → DIRECT/EXPLORE/SCOUT → SYNTHESIZE → DONE
  ├─ Tier 1 → DIRECT EDIT ──────────────────────────────┐
  ├─ Tier 2 → [EXPLORE] → IMPLEMENT ───────────────────┤
  └─ Tier 3 → EXPLORE || SCOUT → ARCHITECT → DECISION GATE
       ├─ APPROVED → IMPLEMENT ─────────────────────────┤
       ├─ AWAITING_USER → APPROVED ─────────────────────┤
       ├─ REJECTED → ABORTED                            │
       └─ BLOCKED                                       │
                                                       ↓
                                                     VERIFY
       ┌─ FAIL → REWORK_BUDGET ── remaining → WRITE ────┘
       │                         └─ exhausted → BLOCKED
       └─ PASS → review required?
                    ├─ no → [CHECKPOINT] → DONE
                    └─ yes → REVIEW
                               ├─ PASS → CHECKPOINT → DONE
                               └─ FAIL → REWORK_BUDGET
                                          ├─ remaining → WRITE → VERIFY → REVIEW
                                          └─ exhausted → BLOCKED
```

`WRITE` означает Direct Edit или Implementer исходного маршрута. Общий budget — не
более двух циклов rework после initial write, суммарно для VERIFY и REVIEW failures;
каждый rework обязательно снова проходит VERIFY и, если он required, REVIEW. Из
любого состояния возможны `BLOCKED` и `ABORTED` с явной причиной.

Reviewer получает исходный DoD, принятые decisions, Base Revision и verification
evidence, а не только пересказ Implementer. Большой diff не встраивается в packet:
Reviewer сам читает его из worktree относительно Base Revision. Checkpoint запрещён
при Reviewer Fail, непройденной обязательной проверке или неизвестном состоянии
worktree.

## 16. Экономия токенов и стоимости

### 16.1. Контекст

Во всех полях `estimated tokens` нормативный estimator совпадает с pinned runtime:
`Math.round(text.length / 4)`, где `text.length` — длина точной JavaScript UTF-16
строки. Validator сохраняет также chars/bytes. Provider-reported input/output/
reasoning tokens измеряются отдельно, никогда не заменяются этим estimator и не
сравниваются с ним как одна величина.

- авторитетный budget — сумма всего pack-provided persistent text, реально видимого
  конкретной роли: PROFILE_RULES, role prompt, agent descriptions и descriptions
  доступных skills; target ≤ 1 500, hard maximum ≤ 2 000 estimated tokens;
- component limits подчинены aggregate budget: role prompt ≤ 2 500 символов,
  skill descriptions ≤ 200 estimated tokens на роль;
- user-owned AGENTS/project instructions измеряются отдельно; превышение 4 000
  символов требует явного waiver и отображается как cost risk;
- validator измеряет реальный cold input floor каждой роли, включая native system
  prompt и tool schemas, и сравнивает его с baseline;
- Task Context Packet p95: до 1 200 estimated tokens;
- checkpoint: до 800 estimated tokens;
- большие файлы читаются диапазонами или по символам;
- failure output сокращается до релевантных строк;
- `@file`/`@directory` attachment interpolation никогда не используется внутри
  Task или shipped custom-command prompts; subagents получают только plain paths.

### 16.2. Agents и tools

- fast lane избегает фиксированной цены child session;
- дорогие модели вызываются только для сложного reasoning, coding и quality gate;
- `steps` даёт ранний MAX_STEPS finish prompt, но не считается runtime cap;
- guard hard-caps LLM calls, Task calls и compactions до provider/tool execution;
- полностью denied tools schema-hidden через exact `* deny`; foreign tools/MCP
  отсутствуют, skill/Task catalogs сужены;
- между LSP и targeted read выбирается источник с меньшим ожидаемым ответом;
- параллельность применяется ради latency, а не считается экономией токенов.

Hard counter не хранится только в памяти plugin. На каждом gate guard определяет root
по persisted parent tree, берёт atomic lease и резервирует именно attempt — каждое
срабатывание `chat.params`, включая outer retry незавершённого assistant message,
считается отдельно. Durable reservations и session evidence сверяются; resume/restart
не обнуляет budget, parallel calls не могут одновременно занять последний slot.
Текущий ещё не отправленный logical stream attempt резервируется до provider call.
Для main work path validator фиксирует AI SDK `maxRetries: 0`; provider-internal
transport retry не считается отдельным hook event и остаётся telemetry boundary. Если
ledger/evidence недоступен, неоднозначен, stale-locked или tree invalid, gate
закрывается; abandoned reservation остаётся использованной до явного audited
recovery. Soft `agent.steps` настраивается ниже либо равным hard limit, чтобы модель
успела вернуть результат до технического отказа. Fixture с намеренно непослушной
моделью и retryable provider error доказывает остановку LLM-only/retry loop; одного
`tool.execute.before` для этого недостаточно.

Нормативный стартовый truncation profile:

```json
{
  "tool_output": {
    "max_lines": 500,
    "max_bytes": 32768
  }
}
```

Runtime может сохранить полный output в truncation storage вне worktree, но core
profile не выдаёт model общий доступ к этому host path. Если обрезка скрыла нужные
строки, agent повторяет команду с более узким scope/range. Thresholds являются
benchmark seeds. Return budgets в prompts:
Explorer ≤ 2 000, Scout/Implementer ≤ 4 000, Architect/Reviewer ≤ 6 000 символов;
превышение допускается только для Blocker evidence. Это policy, поскольку Task
может вернуть полный финальный текст child session в parent.

### 16.3. Сессии

- одна сессия продолжается внутри связного milestone;
- после проверенного checkpoint и смены задачи рекомендуется `/new`;
- `/new` не выполняется автоматически после каждого шага;
- fork используется только для настоящей альтернативной ветки и не считается чистым
  контекстом;
- manual `/compact` используется внутри длинного незавершённого этапа, а не после
  каждой задачи.

### 16.4. Compaction

Нормативный начальный профиль:

```json
{
  "compaction": {
    "auto": true,
    "prune": true,
    "tail_turns": 2
  },
  "agent": {
    "compaction": {
      "model": "{env:OC_MODEL_COMPACTOR}"
    }
  }
}
```

`preserve_recent_tokens` намеренно отсутствует: V1.17.9 выбирает адаптивный budget
25% usable input в пределах 2k–8k. `reserved` также отсутствует в базовом template.
В этой версии он вычитается только когда provider metadata задаёт `model.limit.input`;
иначе overflow threshold равен `context - maxOutputTokens`, и explicit `reserved`
не влияет. Profile doctor вычисляет effective threshold для каждой модели по
resolved `context/input/output` limits. Для каждой пары active role → compactor он
проверяет инвариант: usable input compactor не меньше максимального payload при
compaction trigger active role плюс prompt/output margin. Near-limit resume test
обязателен для каждой пары; недостаточный compactor делает profile invalid, silent
fallback на active model запрещён. Override `reserved` или
`preserve_recent_tokens` разрешён только единым profile после resume/cost benchmark,
а не по грубой таблице context windows.

Compaction является lossy fallback. Критический промежуточный результат должен быть
кратко зафиксирован в проверенном STATE до pruning или длительной паузы. Стоимость
compaction включается в полную стоимость задачи.

### 16.5. Cache

- стабильные prompts и AGENTS не меняются внутри active milestone;
- provider `setCacheKey` включается только при официальной поддержке;
- модели и providers не переключаются без причины внутри одной роли;
- cache effectiveness измеряется не объёмом cache read/write сам по себе, а net cost
  с ценой fresh input, cache read и cache write из зафиксированного pricing snapshot.

## 17. Безопасность изменений

- core устанавливает `snapshot: false`: V1.17.9 snapshot вызывает `git add --all`,
  а repository/global attributes и clean/process filters способны выполнить процесс
  вне `bash` permission;
- recovery опирается на clean base revision, pre/post tracked+untracked audit и
  явный user-approved Git/manual rollback без destructive automation;
- перед edit фиксируется base revision и проверяется dirty worktree;
- пользовательские изменения не перезаписываются;
- Orchestrator по policy не запускает writers параллельно;
- Implementer не изменяет Notebook и configuration control files без отдельного
  пользовательского scope;
- publish, deploy, git push, destructive migrations и удаление данных требуют явного
  разрешения;
- `share` устанавливается в `"disabled"`;
- remote instructions не подключаются автоматически;
- core не подключает MCP; exact MCP возможен только в отдельном audited conditional profile;
- built-in `grep` недоступен, content search идёт только через `safe_search`;
- Task attachments, symlink paths и apply-patch moves fail-closed в guard;
- автоматические shell allowlists не содержат generic readers/interpreters; явно
  approved shell и verification scripts остаются residual-risk boundary §5.2.

Отдельный conditional snapshot profile возможен только после non-executing audit
всех Git config include chains, attributes files и filter/process/fsmonitor surfaces,
canonical version/hash pin Git binary и no-execution fixture. До реализации этого
профиля `snapshot:true` является validation Fail.

Core не гарантирует single writer даже внутри одной Orchestrator session/worktree.
Hard guarantee требует будущего lease plugin или внешней блокировки; до этого
используются policy, pre/post worktree audit и организационный запрет параллельных
OpenCode-процессов на одном worktree.

## 18. Ошибки и восстановление

| Ошибка | Обнаружение и реакция |
| --- | --- |
| Неверная OpenCode version/schema | validator прекращает установку |
| Install/update conflict | dry-run report; target не меняется |
| Пустая или неизвестная model binding | fail до первой рабочей задачи; без fallback |
| Model snapshot/catalog/adapter drift | fail до provider; explicit model rebind transaction |
| Dependency tree manifest mismatch | fail до plugin import; doctor materializes, old tree quarantined |
| Модель без tool support/limits | role smoke test и явный remap |
| Guard plugin/custom tool не загрузился | launcher не стартует либо все base agents остаются disabled; zero provider/tool call |
| Task attachment token | guard отклоняет call; packet перестраивается с plain path |
| Unsafe CLI verb/flag/project/attach | structural argv policy отклоняет до OpenCode process |
| Symlink path или apply-patch move | guard отклоняет call; безопасный explicit edit либо approval |
| Agent/skill/command origin не совпал | preflight/guard Fail до activation; показать canonical origin/hash collision |
| Prompt или catalog превышает budget | validator Fail |
| Простая задача ошибочно делегирована | routing regression fixture |
| Недостаточный packet | один `NEEDS_CONTEXT` round-trip, затем reroute/block |
| Устаревшие строки/файлы | перечитать symbol/current file, сверить base revision |
| Transient model/tool error | одна retry; затем reroute или Blocked |
| Permission denied | вернуть `NEEDS_PERMISSION`, не обходить запрет |
| Reviewer Fail | rework максимум два раза, затем blocker report |
| Dirty worktree с чужими изменениями | остановить overlapping edit, сохранить изменения пользователя |
| Два writer в одной session | Orchestrator сериализует задачи |
| Два OpenCode-процесса | Core не гарантирует lock; задокументировать ограничение |
| Nested Task из subagent | permission smoke test обязан получить deny |
| Experimental LSP выключен | `safe_search` + read; не считать ошибкой |
| Checkpoint write/readback failed | не сообщать success; повторить или Blocked |
| Compaction потеряла детали | восстановиться по verified STATE и git evidence |
| MCP/tool schema bloat | MCP/foreign tools убрать; exact full-deny schemas проверить |
| Prompt injection из web/docs | считать материал данными, не инструкциями |
| Unsafe fetch target/redirect/DNS | `safe_fetch` закрывает socket и возвращает bounded error metadata |
| Cost runaway | soft steps + guard hard call/Task/compaction caps; затем benchmark thresholds |
| Budget ledger corrupt/stale-locked | fail closed; non-LLM profile-doctor audit/quarantine/close-root recovery |
| Неполное cost attribution | economics gate получает `Unverified`, не Pass |
| Quality drift после model swap | полный role benchmark перед принятием профиля |

## 19. Валидация конфигурации

Перед использованием должны выполняться следующие проверки:

1. `opencode --version` и reference platform совпадают; temp/target filesystem
   проходит atomic create/rename/lease probe. Managed runtime root canonical, owner-only,
   mode `0700`, не пересекается с worktree/host OpenCode roots; overlap fixture требует
   explicit safe override и никогда не падает обратно внутрь проекта. Canonical
   OpenCode/rg/npm-runtime/shell/Git paths, versions и hashes совпадают с lock;
   PATH shadow canary не исполняется.
2. Static preflight без импорта кода отклоняет foreign plugin/tool executable
   specs/directories, любой local/remote MCP, `skills.paths/urls`, foreign/duplicate
   agent/skill/command origins, `lsp.*.command`, `formatter.*.command`,
   remote/absolute/tilde/escaping refs и строит sanitized contained copy; fixtures с
   malicious global/system-managed/MDM plugin, custom tool, formatter, remote-MCP,
   command collision, stored `wellknown` auth и account/org remote config не
   исполняются, не подключаются к сети и не создают host canary. Auto/configured
   instruction origin registry exact; root/nested secret/control `AGENTS.md`,
   `CLAUDE.md`, `CONTEXT.md`, symlink, unadopted и hash-drift fixtures дают Fail до
   prompt/provider, а adopted safe instruction явно отображается как provider-visible.
3. После preflight изолированный `opencode debug config` успешно разрешает clean-pack
   и sanitized-global variants и не изменяет реальные global/target paths. Hostile
   `OPENCODE_AUTO_SHARE`, DB/model/config/plugin/compaction/prune variables не попадают
   в child env; unknown credential/build key и loader/shell-injection key также не
   проходят, а exact adopted provider/project key проходит без логирования значения;
   `HOME`/XDG/TEST_HOME указывают только в managed owner-only runtime, а host
   `~/.opencode`, credential/dotfile canaries не читаются. Controlled managed-config
   override указывает на empty `0700` root;
   structural argv fixtures отвергают `--attach`, `--dir`/project positional,
   file/remote/server attach, `--dangerously-skip-permissions`, share/auto-share,
   `--pure`, model/variant/agent и config/plugin overrides, unknown flags и все
   non-allowlisted verbs до OpenCode process.
4. Npm lock integrity разрешается без drift в disposable config tree; effective external-plugin
   list содержит только explicit `profile-guard`, а `safe_search` реально обнаружен.
   Canonical origins/SHA каждого agent, command, prompt и allowed skill совпадают с
   lock; duplicates отсутствуют. Effective LLM tool IDs не содержат unknown custom
   tools или fully denied built-ins; mixed permissions остаются schema-visible и
   отдельно проверяются на execution.
   Install и managed launch подтверждают
   `npm_config_ignore_scripts=true`; lifecycle canary не выполняется. Ошибка
   import/hook/tool schema даёт Fail. Missing/extra/modified/symlink file в ignored
   `node_modules` не импортируется: exhaustive dependency manifest даёт Fail, а
   explicit doctor re-materialization сохраняет прежний tree в quarantine. Hostile
   host `~/.npmrc`/global npm config/proxy/auth canaries не читаются и не получают
   network; git/file/http/foreign-registry lock source получает Fail.
   Effective `Command.list` содержит ровно шесть intended commands плюс inert shadows
   для `init`, `customize-opencode` и каждого locked skill alias вне intended command
   set; intended `review`/`checkpoint` имеют явный winning precedence. Built-in/skill
   interpolation canaries не исполняют shell и не materialize attachment.
5. Отдельные `--pure`, missing-guard и throwing-config-hook probes подтверждают
   `disable: true` для всех base agents, zero `chat.params`/provider reach, root/per-role
   wildcard deny для каждого known и synthetic unknown tool ID, `formatter: false`,
   `lsp: false`, пустой MCP surface и отсутствие частично применённых intended allow maps. Managed
   launcher отклоняет `--pure` до запуска OpenCode.
6. Normal SessionTools integration harness (не `debug agent --tool`, который обходит
   before-hook) и direct hook unit fixtures подтверждают: обычный Task packet проходит,
   Task с resolvable `@file` отклоняется до child read; `apply_patch` с `*** Move to:` отклоняется;
   read/edit/LSP через internal/external symlink, external managed runtime и
   non-existing child symlink-parent отклоняются. Root/nested directory-read fixtures
   завершаются до listing и не раскрывают secret/control names; equivalent allowed
   paths выдаёт только filtered `safe_search mode=files`; guessed missing read не
   возвращает `Did you mean`. Shipped command templates проходят static scan на attachment,
   shell blocks, `$ARGUMENTS` и positional placeholders; non-empty command-argument
   fixture фиксируется как запрещённый operational path. Uncooperative-model fixture
   и retryable-provider fixture подтверждают atomic hard LLM-attempt/Task/compaction
   caps до provider/tool call, serial reservation для parallel children и отсутствие
   reset после resume/restart; main work path подтверждает `maxRetries: 0`.
7. `safe_search` в обоих modes на fixture находит разрешённый path/symbol, уважает caps/truncation,
   не выдаёт root/nested secret, ignored/hidden deny path или symlink target и не
   принимает search root вне worktree. Huge-tree/slow-rg fixtures подтверждают
   candidate/path/argv/time caps и process kill. Built-in `grep` и `glob` фактически
   получают deny. Scout и synthetic unknown role вызывают `safe_search`, но
   `ctx.ask`/guard gate отклоняет их до enumeration/spawn; denied-role canary path не
   открывается.
8. Нет смешения V1/V2 fields, неизвестного `subagent_depth` и deprecated
   `tools`/`maxSteps`.
9. Все model env bindings непусты, exact-match accepted
   `models.snapshot.json`/lock и присутствуют в managed `models`; resolver/launch
   используют `OPENCODE_DISABLE_MODELS_FETCH=true` и hash-verified
   `OPENCODE_MODELS_PATH`. Provider/model/API URL/bundled adapter, variants, options,
   limits, capabilities и pricing зафиксированы; mutable catalog network canary,
   custom/unversioned npm adapter и drift дают Fail до provider call. TUI-selected,
   session-stored/resumed и compaction model/variant/options tamper отклоняются
   `chat.params` до budget reservation/provider; каждая locked role проходит.
10. Managed `agent list` содержит только разрешённые selectable роли; `build`,
   `general`, `explore`, `plan` отключены.
11. Isolated validator `debug agent <role>` показывает правильные model, steps и permissions.
12. Isolated validator `debug skill` обнаруживает все skills и точные skill allowlists; collision
    fixtures из host config-dir, `.claude`, `.agents` и `skills.paths/urls` получают
    Fail, а каждый allowed name разрешается только в locked canonical origin/SHA.
    Единственный extra discovered skill — attested `<built-in>`
    `customize-opencode`; он denied/not offered каждой роли и его alias inert-shadowed.
13. Explorer, Scout, Architect и Reviewer не получают edit/write/apply_patch;
   Explorer/Scout/Architect также не получают bash. Reviewer shell side effects
   проверяются отдельным pre/post audit, а не считаются hard-denied.
14. Все subagents имеют `task: deny`; Orchestrator — точный Task allowlist; реальная
   nested-Task probe получает deny.
15. Root и nested secret/control canaries подтверждают ordered read/edit denies,
    Orchestrator secret `ask`, child secret `deny`, explicit example `allow`, `ask`
    для Orchestrator на `AGENTS.md`/root config, exact Notebook allow и deny/ask для
    `.git`, `.opencode`, lock, package dependencies у каждой роли. Generic bash-read
    command strings не входят в automatic allowlist. При включённом LSP
    project-specific secret canary не должен появляться в LSP output. Это проверяет
    tool rules, но не обещает sandbox side effects allowlisted/approved shell.
    Каждый agent имеет exact runtime Truncate.GLOB external-directory deny; generic
    wildcard и trailing auto-allow считаются Fail.
16. Reviewer pre/post worktree probe обнаруживает source side effects verification.
17. Scout проходит `safe_fetch` public HTTPS fixture; built-in `webfetch` full-denied/
    schema-hidden. Localhost, RFC1918/link-local/IPv6-mapped/cloud-metadata, DNS
    rebinding, redirect-to-private, downgrade, credential/proxy/header и decompression-
    bomb fixtures завершаются без unsafe connect/output; denied role не делает DNS.
    `websearch` либо проходит availability probe, либо получает exact full deny и
    schema-hidden. Core remote/local MCP no-connect canary проходит; MCP проверяется
    только отдельным conditional-profile benchmark.
18. Core/base resolved config имеет `lsp: false` и
    `OPENCODE_DISABLE_LSP_DOWNLOAD=true`; read/edit fixture не запускает/download server.
    Conditional LSP обнаруживается только при feature flag: every non-selected ID
    имеет `{disabled:true}`, selected safe ID omitted и совпадает с pack allowlist +
    PATH binary version/hash. `true`, custom command, `latest`, Npm/cache/project-first
    resolver, unknown server или missing binary дают Fail; empty-cache/no-network
    canary не скачивает code. `safe_search` fallback проходит без LSP.
19. `share: disabled`, `snapshot: false`, `autoupdate: false`, `title.disable: true`,
    `formatter: false`; compaction auto/prune, tail settings и
    `OC_MODEL_COMPACTOR` resolved. Malicious Git clean/process filter fixture не
    исполняется; core отклоняет `snapshot:true`.
20. Для всех models вычислен effective overflow threshold; каждая active
    role→compactor pair проходит usable-input invariant и near-limit resume test.
21. Aggregate persistent-text budget, cold input floor, packet/return fixtures и
    `tool_output` thresholds проходят limits; все auto-instruction origins включены
    в aggregate и origin report.
22. Installer fixtures покрывают dry-run, adopted config/policy, contract re-adoption,
    adopt/re-adopt/remove/preserve project skill, user-owned gitignore/policy/Notebook
    seeds, model bind/rebind snapshot, dependency materialize/tamper recovery,
    instruction adopt/re-adopt, provider/project env-name adoption/removal, conflict, update, fresh/upgrade
    rollback и uninstall/de-adoption; retained-reference fixture не допускает удаления
    pack dependency, подтверждены special lock lifecycle, ownership,
    required/forbidden ignore behavior и отсутствие partial writes. Non-LLM budget
    doctor различает live/stale/corrupt ledger, сохраняет quarantine, закрывает старый
    root без reset cap и допускает только новую root session.
23. Benchmark ledger fixture запрещает fork/new/background, дожидается quiescence и
    не удваивает session rollup при reconciliation. Run/db/export/stats проходят
    одним managed launcher/runtime scope, а manifest фиксирует launcher version,
    install UUID и runtime-scope ID; baseline arm принимает только embedded locked
    manifest, включает один Task-denied agent с теми же isolation/safety/accounting
    controls и equal aggregate call ceiling. Arbitrary baseline config и direct host
    `opencode` fixtures получают Fail.

## 20. Benchmark и критерии готовности

### 20.1. Benchmark design

Сравниваются baseline и новый profile на одном git snapshot и одинаковых задачах.
Единица эксперимента — один scenario attempt в отдельной root session.

- минимум 30 заранее закрытых holdout scenarios: 10 Tier 0/1, 10 Tier 2, 10 Tier 3;
  tuning scenarios хранятся отдельно и не входят в acceptance gate;
- минимум три повторения каждого scenario для каждого profile; power analysis может
  потребовать больше повторений;
- baseline: отдельный pack-owned/hash-locked монолитный OpenCode agent на той же
  implementation-quality model, что `OC_MODEL_IMPLEMENTER`;
- фиксируются OpenCode version, role-model mapping, provider settings и revision;
- минимум два model-role profiles настраиваются только на tuning set; holdout не
  используется для выбора победителя;
- каждый attempt начинается с одного чистого git snapshot; порядок baseline/profile
  рандомизируется в paired blocks;
- cold-cache и warm-cache cohorts запускаются, публикуются и проходят production
  gate независимо; post-hoc выбор выгодной cohort и смешивание результатов запрещены;
- исключать attempt можно только из-за заранее определённой внешней contamination,
  симметрично для обоих profiles и до просмотра outcome. Ошибка/нарушение самого
  agent не является contamination;
- deterministic checks выполняются автоматически, а human/reviewer rubric оценивается
  вслепую без имени profile и модели;
- внутри attempt запрещены `/new`, fork и background subagents. Их обнаружение
  делает attempt отклонённым: весь связанный spend остаётся в CPAT numerator,
  accepted denominator не увеличивается; все Task calls должны завершиться;
- bootstrap unit для качества — scenario cluster со всеми repeats и обоими profiles.
  Если 95% interval слишком широк, увеличивается прежде всего число независимых
  scenarios, а не объявляется победа по point estimate.

Baseline не является user config override. Release содержит immutable
`benchmark/profiles/baseline/{opencode.jsonc,baseline-manifest.json}`; benchmark
harness принимает только exact embedded manifest hash и создаёт отдельный sanitized
staging tree. Тот же guard implementation активируется в явно скомпилированном
`baseline` contract mode: один agent, `task: deny`, title/share/MCP/foreign origins
disabled, тот же safe file/search boundary, verification policy, XDG/system/auth/env
isolation, output accounting и provider telemetry. Его hard logical-attempt cap равен
максимальному aggregate LLM-attempt budget profile arm, чтобы safety ceiling не давал
одной стороне скрытого преимущества. Arbitrary manifest/path flag запрещён.

Formal quality rubric: `DoD correctness`, `behavioral correctness`, `scope discipline`,
`safety/backward compatibility`, `maintainability/evidence` оцениваются `0 | 1 | 2`.
Результат принят, только если обязательные deterministic checks прошли, нет
`Blocker`/`Major`, ни одна категория не равна `0`, а сумма не ниже `8/10`.

Метрики качества:

- human accept/reject;
- deterministic build/lint/typecheck/test pass;
- first-pass completion rate;
- Blocker/Major/Minor/Note findings независимого blind review;
- дефекты после принятия;
- успешность продолжения после checkpoint/compaction.

Метрики экономики:

- provider-billed CPAT и OpenCode-estimated CPAT;
- `fresh_input`, output, reasoning, cache read/write и `total_prompt`;
- steps и число subagent calls;
- число retries, rework и compactions;
- rejected spend, mean, p50, p95 и max task-tree cost;
- latency как вторичная метрика.

В V1.17.9 `tokens.input` трактуется как `fresh_input`; `total_prompt` равен
`fresh_input + cache.read + cache.write`. OpenCode `cost` обычно является estimate
из token usage и model pricing metadata, поэтому pricing snapshot сохраняется рядом
с результатом и не называется invoice.

### 20.2. Атрибуция usage и стоимости по уровню telemetry

Benchmark harness:

1. запускает все operations только через pack-owned
   production `opencode-profile` для profile arm или pack-owned benchmark entrypoint
   с embedded baseline-manifest hash для baseline arm; direct binary допустим лишь
   как внутренний `exec` уже после общего launcher scrub/preflight. Harness фиксирует launcher version,
   install UUID и один выбранный external runtime/provider scope для всех операций
   попытки;
2. извлекает intended root session ID из managed `run --format json`;
3. через managed read-only `db --format json` и recursive CTE собирает root и всех
   descendants по `session.parent_id`;
4. в изолированном benchmark worktree/provider scope находит все sessions, созданные
   между `started_at` и окончательным `cutoff_at`. Новый несвязанный root помечает
   attempt как rejected, но он и все descendants включаются в attributable spend;
5. после возврата intended root повторяет traversal всех обнаруженных roots, пока
   множество session IDs, их
   `time_updated`, tokens и cost стабильны два последовательных опроса. Background
   execution запрещён; поздний descendant до quiescence помечает attempt rejected и
   учитывается. `cutoff_at` фиксируется только после quiescence;
6. суммирует session aggregate columns каждого ID ровно один раз, включая
   Orchestrator, Task children, compaction, retries и rework. Message exports и
   `step-finish` — только reconciliation channels и не прибавляются к rollup;
7. ограничивает recursive traversal depth, обнаруживает cycles и требует parent для
   каждого non-root;
8. связывает все повторные и отклонённые attempts с scenario ID в benchmark manifest;
9. сверяет session tree через managed `export <sessionID>`; managed
   `stats --days <N> --models 20 --project ""` используется только для
   aggregate reconciliation, не для attribution конкретной задачи.

Manifest каждой попытки содержит `attempt_uuid`, scenario/profile/repetition,
cache cohort, intended root session ID, все attributed session IDs, disposition и
reason, `started_at`, `root_returned_at`, `cutoff_at`, git SHA, OpenCode version,
launcher version, install UUID, runtime-scope ID, price-snapshot hash и provider
scope; baseline arm дополнительно содержит baseline-manifest hash. Production и benchmark configs отключают
`title`, поэтому неперсистируемого title LLM call нет.

Primary metric для cohort/profile:

```text
CPAT = provider-billed cost всех attempts в cohort / число принятых результатов
```

В numerator входят успешные, отклонённые, blocked attempts, agent-caused protocol
violations, retries, rework, служебные calls, cache writes и compaction. При нуле
принятых результатов CPAT равен infinity. Исключается только заранее объявленная
внешняя contamination по правилу выше. Для распределения дополнительно публикуется
полный OpenCode-estimated cost каждого attributed session forest и rejected spend;
provider-billed forest cost доступен только на Level A.

Источник истины для денег — provider billing/usage API или invoice. Различаются две
независимые величины: `billing coverage` — доля provider bill внутри изолированного
benchmark scope, и `attribution granularity` — доля bill, сопоставленная attempt или
`paired block × profile arm`. Для economics Pass обе должны быть не ниже 95% на
требуемом уровне.

| Уровень telemetry | Доступное утверждение |
| --- | --- |
| A: request-level billed records + stable request IDs | per-attempt billed cost, p95 и scenario-cluster bootstrap |
| B: отдельный закрытый bill для каждого `paired block × profile arm` | cohort CPAT-ratio CI через paired resampling independently billed arm subtotals |
| C: один изолированный cohort invoice total | только point CPAT; billed CI/p95 = `N/A` |
| D: OpenCode session rollups + pinned prices | per-attempt estimated distribution, не provider-billed |
| E: только managed `stats` | aggregate sanity check, не attribution |

Level A сохраняет request IDs и join к attempt. Level B получает два независимо
billed subtotal внутри каждого paired block — отдельно для baseline и profile —
через независимые provider projects/keys или непересекающиеся закрытые billing
windows; затем arm totals объединяются только в paired contrast для bootstrap.
Один общий bill на обе arms является Level C, не Level B. Нельзя распределять cohort
invoice пропорционально OpenCode estimates и затем bootstrap-ировать искусственную
дисперсию. При Level C–E economics gate получает
`Unverified`; quality и token gates публикуются отдельно. Недоступные cache/reasoning
breakdowns получают `N/A`, а не ноль.

Нормативная bootstrap unit для обоих Level A/B — paired scenario cluster: один
заранее зафиксированный scenario со всеми repeats одной cache cohort и обеими arms.
Level B биллит каждый `cluster × arm` отдельно. В каждой bootstrap replicate paired
clusters выбираются с возвращением; затем для каждой arm заново вычисляется
`CPAT* = Σ billed_cost / Σ accepted`, после чего
`R* = 1 - CPAT*_profile / CPAT*_baseline`. Усреднять per-block ratios запрещено.
Нулевой aggregate accepted denominator profile означает Fail (`CPAT = infinity`);
нулевой denominator baseline или `infinity/infinity` делает contrast undefined и
economics gate `Unverified`. Point estimate также всегда является ratio of sums.

### 20.3. Production acceptance gate

- ни одного ухудшения на security/data-loss сценариях;
- cold-cache и warm-cache cohorts независимо удовлетворяют всем применимым quality,
  token и economics thresholds ниже;
- deterministic gates проходят для всех принятых задач;
- для contrast `success_profile - success_baseline` нижняя односторонняя 95% граница
  строго больше `-0.05`;
- economics telemetry имеет Level A или B, а billing coverage и attribution
  granularity не ниже 95%;
- для contrast `1 - CPAT_profile / CPAT_baseline` нижняя односторонняя 95% граница
  не меньше `0.20`. На Level A и B применяется один алгоритм paired
  scenario-cluster bootstrap выше; Level B использует два independently billed arm
  subtotals для каждого cluster;
- fresh input на accepted result и total prompt публикуются раздельно; снижение
  fresh input не меньше 20% без роста total prompt cost;
- на Level A billed p95 task-tree cost не выше baseline более чем на 10%; на Level B
  применяется тот же предел к распределению block CPAT, а billed task p95 = `N/A`;
- минимум 90% простых fixtures выполняются без subagent;
- simple-task cost не превышает baseline более чем на 10%;
- medium route использует не более трёх subagent calls без retry;
- high-risk route включает Architect и Reviewer;
- после общего budget в два rework cycles автоматический loop прекращается;
- resume из checkpoint успешно восстанавливает 9 из 10 контрольных задач.

Optimization target после первого tuning cycle:

- provider-billed CPAT ниже baseline минимум на 30%;
- fresh input на accepted result ниже минимум на 40%;
- simple-task cost ниже минимум на 50%;
- доля вынужденных escalation с дешёвой модели на дорогую ниже 20%.

Если production gate не достигнут, configuration pack не называется готовым.

## 21. Этапы поставки

1. Утвердить это ТЗ и разрешить создание runtime-артефактов.
2. Создать scaffold конфигурации, guard/search plugin, prompts, skills и Notebook templates.
3. Реализовать validator и role smoke tests.
4. Проверить permissions и failure fixtures.
5. Зафиксировать baseline и выполнить benchmark.
6. Настроить routing, budgets, steps и role profiles по данным.
7. Провести независимое ревью и выпустить README/install guide.

До явного утверждения этого документа разрешены только его правки, ревью и анализ.
После утверждения пользователь отдельно разрешает создание runtime-файлов.

## 22. Принятые архитектурные решения

- продукт является OpenCode configuration pack, а не отдельной системой;
- production target — OpenCode `1.17.9` V1;
- Router реализован как policy primary Orchestrator, не внешний сервис;
- простые задачи используют fast lane без обязательного Router skill/subagent;
- модели и провайдеры сменные и связываются через capability roles;
- task-specific контекст subagent состоит из Task packet и чтения файлов on demand;
  кроме него OpenCode добавляет system prompt, role prompt, project instructions,
  tool schemas и разрешённый skill catalog;
- full transcript не копируется в child task;
- Packet является ephemeral contract;
- core использует один обязательный fail-closed project-local guard/search plugin;
- recursion guard реализован `permission.task`, а не отсутствующим `subagent_depth`;
- альтернативные selectable built-in agents отключены;
- установка является transactional installer-managed overlay с hash ownership;
- compaction использует отдельную capability-модель, title LLM call отключён;
- Reviewer обязателен по риску, а не для каждой мелкой правки;
- checkpoint milestone-based и не требует автоматического `/new`;
- качество и экономия подтверждаются paired benchmark с полной session-tree usage/
  estimated-cost attribution и fail-closed provider-billing telemetry levels.

## 23. Оставшиеся вопросы

### Approval gate

- Явное утверждение пользователем перехода от ТЗ к созданию runtime-конфигурации.

Draft 0.4 зафиксирован как review checkpoint. Реализация runtime-артефактов не
начиналась; замечания пользователя войдут в следующую ревизию до approval gate.

### Non-blocker, решаются при установке или benchmark

- конкретные provider/model IDs для capability slots;
- provider-specific variants и cache options;
- точные project verification commands;
- необходимость optional lease или telemetry plugin;
- окончательная настройка steps и budgets после измерений.

## 24. Официальные источники

- OpenCode Config: <https://opencode.ai/docs/config/>
- OpenCode Agents: <https://opencode.ai/docs/agents/>
- OpenCode Permissions: <https://opencode.ai/docs/permissions/>
- OpenCode Skills: <https://opencode.ai/docs/skills/>
- OpenCode Rules: <https://opencode.ai/docs/rules/>
- OpenCode Commands: <https://opencode.ai/docs/commands/>
- OpenCode Models: <https://opencode.ai/docs/models/>
- OpenCode CLI: <https://opencode.ai/docs/cli/>
- OpenCode MCP: <https://opencode.ai/docs/mcp-servers/>
- OpenCode Plugins: <https://opencode.ai/docs/plugins/>
- OpenCode Custom Tools: <https://opencode.ai/docs/custom-tools/>
- OpenCode V2 status: <https://opencode.ai/v2/docs>
- V1 to V2 migration: <https://opencode.ai/v2/docs/migrate-v1>
- Pinned V1.17.9 config schema: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/core/src/v1/config/config.ts>
- Pinned config merge/auth behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/config/config.ts>
- Pinned system-managed config paths: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/config/managed.ts>
- Pinned sharing override behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/share/session.ts>
- Pinned snapshot subprocess behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/snapshot/index.ts>
- Pinned Task child-session behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/tool/task.ts>
- Pinned grep permission behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/tool/grep.ts>
- Pinned glob permission behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/tool/glob.ts>
- Pinned LSP path behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/tool/lsp.ts>
- Pinned MCP lifecycle: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/mcp/index.ts>
- Pinned skill discovery: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/skill/index.ts>
- Pinned plugin hooks: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/plugin/src/index.ts>
- Pinned plugin bootstrap: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/project/bootstrap.ts>
- Pinned prompt attachment behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/session/prompt.ts>
- Pinned auto-instruction behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/session/instruction.ts>
- Pinned command discovery: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/command/index.ts>
- Pinned CLI run/project overrides: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/cli/cmd/run.ts>
- Pinned TUI project override: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/cli/cmd/tui.ts>
- Pinned V1 step-loop behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/session/prompt.ts>
- Pinned MAX_STEPS prompt: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/core/src/session/runner/max-steps.ts>
- Pinned apply-patch behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/tool/apply_patch.ts>
- Pinned read directory/typo behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/tool/read.ts>
- Pinned webfetch behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/tool/webfetch.ts>
- Pinned tool discovery: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/tool/registry.ts>
- Pinned LLM tool schema filtering: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/session/llm/request.ts>
- Pinned formatter behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/format/index.ts>
- Pinned truncation permissions: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/agent/agent.ts>
- Pinned npm loader: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/core/src/npm.ts>
- Pinned mutable model catalog: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/core/src/models-dev.ts>
- Pinned provider adapter resolution: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/provider/provider.ts>
- Pinned compaction behavior: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/session/compaction.ts>
- Pinned usage/cost calculation: <https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/session/session.ts>

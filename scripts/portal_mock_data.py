"""Build complete design fixtures without rewriting the original research records."""
import json
from pathlib import Path

WORK = Path(__file__).resolve().parent.parent / 'prototype'

def read(name):
    return json.loads((WORK / name).read_text(encoding='utf-8-sig'))

def onboarding(app, version):
    slug, kind = app['repositorySlug'], app['agentKind']
    base = f'https://gitlab.example.invalid/ai-apps/{slug}/-/raw/v{version}'
    setup = {
        'skill': '读取 SKILL.md 与依赖清单，确认宿主支持的技能目录；安装到当前宿主并保留已有技能，按需重载后确认可发现。',
        'mcp': f'按清单配置 Streamable HTTP 服务 https://mcp.example.invalid/{slug}/mcp，合并当前宿主 MCP 配置，保留已有连接；重载后检查连接并列出工具。',
        'local-tool': '从发布清单取得固定版本安装包并校验 SHA-256，检查所需运行时与依赖，在独立环境安装；按清单启动本地服务并注册到当前 Agent。',
        'plugin': '识别浏览器或业务客户端版本，按发布清单安装配套插件与 Agent 连接组件；保留原配置，在示例环境验证连接。',
        'workflow': '导入工作流及其依赖，检查每个节点需要的工具和权限，将工作流注册给当前 Agent；先使用示例输入运行。',
        'template': '读取模板说明和适用条件，将模板注册到当前 Agent 可引用的资源目录；保留原模板，以示例任务验证输出。',
    }[kind]
    return f'''【Mock 接入示例】以下地址为保留的演示域名。仅用于评审接入流程，不访问地址、不下载或执行安装。

请将「{app['name']}」v{version} 接入当前 Agent。
发布清单：{base}/ai-app.yaml
使用文档：{base}/README.md
安装与验证：{base}/docs/agent-onboarding.md
{('服务端点：https://mcp.example.invalid/'+slug+'/mcp') if kind == 'mcp' else ('版本包：https://packages.example.invalid/ai-apps/'+slug+'/v'+version+'/'+slug+'.zip')}

1. 核对当前 Agent、系统环境和已有版本。前置条件：{'；'.join(app['requirements'])}。来源、签名及校验值以固定版本发布清单为准。
2. {setup} 相同版本已接入时复用现有安装；升级前备份配置。
3. 凭据从宿主安全配置或用户授权渠道取得，不写入提示词、仓库或输出。缺少权限时说明所需权限，保留已完成步骤。
4. 首次任务：{app['exampleTask']}
5. 最小验证：{app['verification']} 报告安装位置、实际版本、连接状态和首次使用结果；失败时保留日志并恢复原配置。

使用边界：{'；'.join(app['boundaries'])}。
这是完整接入流程的设计样例，不表示真实项目已提供上述服务或完成验证。'''

def build_payloads():
    tools = read('portal-full-data.json')
    copies = {x['id']: x for x in read('portal-user-copy.json')}
    capabilities = {x['id']: x for x in read('capability-discovery-copy.json')}
    metadata = read('portal-project-metadata.json')
    projects = {x['id']: x for x in metadata['projects']}
    fixtures = read('portal-mock-content.json')['applications']
    assert len(fixtures) == len(tools) == 17
    assert {x['id'] for x in fixtures} == {x['id'] for x in tools}
    data = {x['id']: x for x in tools}
    for app in fixtures:
        key = app['id']
        t, m, c = data[key], projects[key], copies[key]
        for field in ('name','scenario','inputs','outputs','tags','boundaries','exampleTask'):
            t[field] = app[field]
        t.update(sampleData=True, source=f"ai-apps/{app['repositorySlug']} · README 与使用指南（示例）", evidenceLabel='Mock 数据 · 用于体验完整应用流程', needs=[], methods=[])
        t['forms'] = ['平台'] if app['accessMode'] == 'platform' else [app['agentKind']]
        c.update(summary=app['summary'], firstStep=app['firstStep'], outcome='、'.join(app['outputs']))
        m.update(accessMode=app['accessMode'], lifecycle='available', sampleData=True,
                 repository=f"ai-apps/{app['repositorySlug']}", documentationSummary=app['documentationSummary'],
                 verification=app['verification'])
        entry = dict(id='mock-'+key, label='在线工作台' if app['accessMode']=='platform' else 'Agent 接入',
                     accessMode=app['accessMode'], status='ready', demo=True, requirements=app['requirements'],
                     steps=app['steps'], description=app['summary'])
        if app['accessMode'] == 'platform':
            entry.update(demoKind='app', demoProjectId=key)
            m['platformDemo'] = app['platformDemo']
        else:
            entry.update(agentKind=app['agentKind'], onboardingPrompt=onboarding(app,m['version']))
        m['entries'] = [entry]
        capabilities[key]['keywords'] = list(dict.fromkeys(capabilities[key]['keywords'] + app['tags']))
    metadata.update(sampleData=True,note='全部17项应用均使用补全后的Mock资料与可体验入口；名称沿用课题，详细信息用于通用产品设计，不表示真实能力、部署或验收情况。')
    return {'pt-data':tools,'pt-user-copy':list(copies.values()),'pt-capabilities':list(capabilities.values()),'pt-project-metadata':metadata}

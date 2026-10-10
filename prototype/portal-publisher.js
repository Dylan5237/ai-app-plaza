  // Publisher states are local design fixtures; no Agent, GitLab or catalog API is invoked.
  const shareApp={id:'docpilot-share-demo',name:'DocPilot 文档助手',technicalName:'docpilot',owner:'我（示例）',tags:['文档处理','知识整理'],scenario:'整理项目文档或知识库素材，将 Word、PDF 转为便于检索和引用的 Markdown。',inputs:['Word / PDF 文档','可选输出目录'],outputs:['结构化 Markdown','图片与引用资源目录'],source:'ai-apps/docpilot · v1.0.0（发布示例）',evidenceLabel:'浏览器内发布演示，未验证真实项目',needs:[]};
  const shareSummary='将 Word、PDF 转为结构化 Markdown，整理图片与引用资源。';
  const publishingPrompt=`请帮助我“分享我的AI应用”，基于当前项目上下文准备一份可审阅的发布草稿。

1. 阅读项目源码、README、依赖、使用说明及当前广场发布契约。复用已有 GitLab 仓库，识别真实的应用名称、用途、作者、版本、日期、适用场景、输入、输出和使用边界；不能确认的信息向我询问，不编造。
2. 根据项目能力生成作者自定义标签；我可用自然语言调整。生成 ai-app.yaml、README 与接入说明，字段以广场当前契约为准。平台应用提供可访问链接；其他应用提供完整的 Agent 接入提示词，包含可信来源、固定版本与校验、环境要求、安装配置、验证和首次使用方法。
3. 检查待上传文件、依赖与使用入口，排除凭据和不应共享的文件。通过安全认证使用仓库权限，不索取或回显令牌。
4. 返回只读预览：应用资料、目标仓库与分支、版本、共享范围、上传内容和检查结果。需要调整时回传新草稿；当前草稿未经我确认，不进行外部发布。
5. 我确认后，在授权范围内上传源码、发布固定版本、登记到广场并回读。分别报告每一步状态和应用链接；失败时保留已完成步骤，只恢复失败环节。不要把收录成功视为使用者已安装或验证成功。

当前为设计示例：本原型未连接广场发布服务。可整理本地草稿；不要依据本提示词执行真实上传、登记或安装。`;
  function syncSharedApplication(){
    if(!state.share.added||tools.some(t=>t.id===shareApp.id))return;
    tools.push({...shareApp,tags:[...shareApp.tags]});
    copies.set(shareApp.id,{id:shareApp.id,summary:shareSummary,helpLabel:shareApp.owner,firstStep:'准备一份用于验证的示例文档，由你的 Agent 完成接入后运行。',outcome:shareApp.outputs.join('、')});
    capabilities.set(shareApp.id,{id:shareApp.id,capability:'整理文档与知识素材',keywords:['Word','PDF','Markdown','文档处理','知识整理']});
    projectMetadata.set(shareApp.id,{id:shareApp.id,version:'1.0.0',createdAt:'2026-10-10',updatedAt:'2026-10-10',accessMode:'agent',repository:'ai-apps/docpilot',documentationSummary:'README、格式支持表、本地部署及 Agent 接入指南',verification:'转换含图片与表格的示例文档，核对标题层级、资源路径和转换日志',entries:[{label:'Agent 接入',accessMode:'agent',status:'ready',demo:true,requirements:[],steps:['复制接入提示词，发送给你正在使用的 Agent。','由 Agent 检查环境，读取作者说明并完成接入。','用一份示例文档验证结果，再处理正式材料。'],onboardingPrompt:'请将 DocPilot 文档助手 v1.0.0 接入当前 Agent。\n\n从作者发布的固定版本读取接入清单，核对可信来源、下载校验、系统依赖和安装位置。按说明完成本地安装与 Agent 配置，保留已有配置；需要重载时提示我。\n使用一份示例文档验证 Markdown 与图片输出，报告实际版本、输出位置、验证结果和首次使用方法。凭据通过安全配置使用，不回显。\n\nMock 发布清单：https://gitlab.example.invalid/ai-apps/docpilot/-/raw/v1.0.0/ai-app.yaml\n版本包：https://packages.example.invalid/ai-apps/docpilot/v1.0.0/docpilot.zip\n环境：Python 3.11，独立虚拟环境；安装后在当前 Agent 注册文档转换入口。\n使用边界：扫描件先经 OCR；复杂表格与外链资源需对照原文。\n这是发布流程设计示例。地址为演示域名，不要访问或执行安装。'}]});
  }
  function shareFacts(){return `<h2>本次发布范围</h2><dl class="pt-share-facts"><div><dt>仓库</dt><dd>ai-apps/docpilot <span class="pt-share-caption">（示例）</span></dd></div><div><dt>分支</dt><dd>main</dd></div><div><dt>版本</dt><dd>v1.0.0</dd></div><div><dt>共享范围</dt><dd>公司内部<br><span class="pt-share-caption">使用者须有仓库访问权限</span></dd></div><div><dt>作者</dt><dd>我（示例）</dd></div></dl><p class="pt-share-files">上传内容：源码与依赖清单、README、应用资料及 Agent 接入说明。<br>草稿检查：必需资料已齐全；排除凭据与本地配置。<br>以上均为演示数据。</p>`}
  function renderSharePrompt(){return `<div class="pt-share-body"><section class="pt-share-panel pt-share-compose"><label class="pt-agent-label" for="pt-publish-text">发布提示词</label><textarea class="pt-share-text" id="pt-publish-text" readonly spellcheck="false">${esc(publishingPrompt)}</textarea><div class="pt-share-foot"><span id="pt-publish-copy-message" role="status">${state.share.copied?'已复制，粘贴到有项目上下文的 Agent。':'项目资料由 Agent 整理，你只需审阅。'}</span><button class="pt-button pt-button-primary" data-share-copy>${ico('copy')}复制发布提示词</button></div></section><aside class="pt-share-panel"><h2>在你的项目中继续</h2><ol class="pt-share-steps"><li>${ico('folder-open')}<div>打开已有项目<p>使用了解该项目的 Agent。</p></div></li><li>${ico('bot')}<div>粘贴发布提示词<p>Agent 整理应用资料、自定义标签与使用入口。</p></div></li><li>${ico('eye')}<div>回来审阅预览<p>确认内容与共享范围后，再发布。</p></div></li></ol><div class="pt-share-wait">原型尚未连接 Agent。可先体验一份示例草稿。<br><button class="pt-link" data-share-preview>体验发布示例${ico('arrow-right')}</button></div></aside></div>`}
  function renderSharePreview(){return `<div class="pt-share-body"><article class="pt-share-panel pt-share-preview"><span class="pt-share-caption">Agent 生成 · 示例草稿 01 · 创建 / 更新：2026-10-10</span><div class="pt-detail-title"><h2>${esc(shareApp.name)}</h2><span class="pt-card-version">v1.0.0</span></div><p class="pt-detail-description">${esc(shareSummary)}</p><div class="pt-tags" aria-label="作者自定义标签">${shareApp.tags.map(t=>`<span class="pt-tag">${esc(t)}</span>`).join('')}</div><section class="pt-detail-section"><h2>适用场景</h2><p>${esc(shareApp.scenario)}</p></section><div class="pt-detail-io"><section class="pt-detail-section"><h2>准备材料</h2>${detailList(shareApp.inputs)}</section><section class="pt-detail-section"><h2>预期产出</h2>${detailList(shareApp.outputs)}</section></div><section class="pt-detail-section"><h2>使用入口</h2><p>接入我的Agent · 安装、配置与首次验证说明已生成。</p></section></article><aside class="pt-share-panel">${shareFacts()}</aside></div><footer class="pt-share-foot"><div class="pt-actions"><button class="pt-link" data-share-prompt>返回提示词</button><button class="pt-link" data-share-adjust>${ico('message-square')}让Agent调整</button></div><div class="pt-actions"><button class="pt-link" data-share-fail>体验收录失败</button><button class="pt-button pt-button-primary" data-share-publish>确认发布示例${ico('arrow-right')}</button></div></footer>`}
  function renderShareResult(){
    const s=state.share,running=s.outcome==='running',failed=s.outcome==='partial',ok=s.outcome==='success';
    const phases=[['源码上传','ai-apps/docpilot · main'],['版本发布','v1.0.0 · 固定版本'],['广场收录',failed?'登记请求超时；已上传内容保留，无需重复上传。':'能力介绍、作者标签与使用入口']];
    const rows=phases.map(([title,note],i)=>{const done=s.progress>i,broken=failed&&i===2,label=done?'已完成':broken?'未完成':running&&s.progress===i?'进行中':'等待前一步';return `<li data-share-phase="${i}" data-status="${done?'complete':broken?'failed':'pending'}">${ico(done?'circle-check':broken?'circle-alert':'circle')}<div>${title}<p>${esc(note)}</p></div><span class="pt-share-result-state ${broken?'is-failed':''}">${label}</span></li>`}).join('');
    return `<div class="pt-share-body"><article class="pt-share-panel"><div class="pt-share-result-heading">${ico(ok?'circle-check':failed?'circle-alert':'loader')}<h2>${ok?'示例已收录到广场':failed?'已上传，广场收录待恢复':'正在演示发布'}</h2></div><p class="pt-share-caption">${esc(shareApp.name)} · v1.0.0 · 示例草稿 01</p><ol class="pt-share-results" aria-label="发布阶段状态">${rows}<li data-share-phase="3" data-status="not-run">${ico('bot')}<div>接入验证<p>由使用者复制接入提示词，在自己的 Agent 中安装并验证。</p></div><span class="pt-share-result-state">未执行</span></li></ol></article><aside class="pt-share-panel pt-share-next"><h2>${failed?'继续完成收录':ok?'开始分享':'正在处理'}</h2><p class="pt-share-caption">${failed?'把修复提示词交给 Agent，复用已发布版本，仅恢复广场收录。':ok?'打开应用详情，查看使用者会看到的介绍与 Agent 接入入口。':'完成后会显示每一步结果。可以离开此页，稍后从分享入口查看。'}</p>${ok?`<button class="pt-button pt-button-primary" data-share-view>查看我的AI应用${ico('arrow-up-right')}</button><button class="pt-link" data-share-restart>重新体验</button>`:failed?`<button class="pt-button pt-button-primary" data-share-repair>${ico('copy')}获取修复提示词</button><button class="pt-link" data-share-retry>再次检查收录（演示）${ico('refresh-cw')}</button>`:''}<p class="pt-share-files">演示流程：所有状态仅发生在当前原型中，未真实上传或发布；也未执行安装验证。</p></aside></div>`;
  }
  function renderGuide(){const s=state.share;$('#pt-guide').innerHTML=`<button class="pt-link pt-back" data-back>${ico('arrow-left')}返回能力发现</button><header class="pt-share-head"><div><h1>分享我的AI应用</h1><p>让 Agent 整理项目，你来确认如何分享。</p></div><span class="pt-share-badge">演示流程</span></header><ol class="pt-share-progress" aria-label="发布流程">${[['prompt','交给 Agent'],['preview','发布预览'],['result','发布结果']].map(([key,label],i)=>`<li ${s.stage===key?'aria-current="step"':''}><span>${i+1}</span>${label}</li>`).join('')}</ol>${s.stage==='preview'?renderSharePreview():s.stage==='result'?renderShareResult():renderSharePrompt()}`;iconRender()}
  function openShareContext(kind){
    const repair=kind==='repair';
    $('#pt-share-prompt-title').textContent=repair?'恢复广场收录':'交给Agent调整';
    $('#pt-share-prompt-note').textContent=repair?'复制到刚才的 Agent 对话，继续处理未完成的步骤。':'复制到刚才的 Agent 对话，再用自然语言说明要修改的内容或标签。';
    $('#pt-share-context-text').value=repair?`请恢复 DocPilot 文档助手的广场收录。\n上下文：示例草稿 01；仓库 ai-apps/docpilot；分支 main；版本 v1.0.0；共享范围公司内部。\n已完成：源码上传、版本发布。失败阶段：广场收录，登记请求超时。\n先查询登记结果，避免重复登记；若未完成，只重试广场收录，复用现有固定版本，不重新上传或创建版本。回读应用详情，报告实际结果和链接。接入验证未执行，不要报告已安装。\n这是设计示例；仓库和任务均为模拟信息，本原型未连接发布服务。不要执行真实写入。`:`请调整“分享我的AI应用”的当前发布草稿，依据我接下来给出的自然语言要求修改内容或作者标签。\n上下文：示例草稿 01；DocPilot 文档助手；版本 v1.0.0；仓库 ai-apps/docpilot；分支 main；共享范围公司内部。\n简介：${shareSummary}\n作者标签：${shareApp.tags.join('、')}。\n重新核对项目证据与入口，生成新草稿并回传只读预览，说明变动；我确认新草稿之前不发布。\n这是设计示例，不具备真实仓库或发布会话，不执行真实写入。`;
    $('#pt-share-context-message').textContent='提示词包含当前草稿上下文。';$('#pt-share-prompt').showModal();$('#pt-share-context-text').scrollTop=0;
  }
  async function copySharePrompt(field,message){let copied=false;try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(field.value);copied=true}}catch{}if(!copied){field.focus();field.select();try{copied=document.execCommand('copy')}catch{}}message.textContent=copied?'已复制，粘贴到有项目上下文的 Agent。':'已选中完整提示词，请按 Ctrl + C 复制。';return copied}
  async function publishDemo(outcome,retry=false){
    if(state.share.outcome==='running')return;
    Object.assign(state.share,{stage:'result',outcome:'running',progress:retry?2:0});render();save();
    for(let phase=state.share.progress;phase<3;phase++){
      await new Promise(resolve=>setTimeout(resolve,450));
      if(phase===2&&outcome==='partial'){state.share.outcome='partial';break}
      state.share.progress=phase+1;
      if(phase===2){state.share.outcome='success';state.share.added=true}
      save();if(state.nav==='guide'&&!state.selected)renderGuide();
    }
    save();render();status(state.share.outcome==='success'?'演示完成：应用已加入当前原型目录。':'演示结果：版本已发布，广场收录待恢复。');
  }

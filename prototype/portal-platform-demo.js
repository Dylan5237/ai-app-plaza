  function platformDemoContext(){const t=tools.find(t=>t.id===demo.projectId),m=projectMetadata.get(demo.projectId);return {t,m,d:m?.platformDemo}}
  function renderPlatformDemo(){
    const {t,d}=platformDemoContext();if(!t||!d)return;
    const steps=['选择任务','预览内容','查看结果'];
    let content='',actions='';
    const next=label=>`<button class="pt-button pt-button-primary" data-demo-next>${label}${ico('arrow-right')}</button>`;
    if(demo.step===0){
      content=`<p class="pt-demo-note">使用内置 Mock 材料体验「${esc(t.name)}」，操作仅改变当前演示状态。</p><label class="pt-demo-field" for="pt-demo-task">${esc(d.taskLabel)}<select id="pt-demo-task">${d.tasks.map(task=>`<option ${task===demo.task?'selected':''}>${esc(task)}</option>`).join('')}</select></label><div class="pt-demo-result"><h3>${esc(d.prepareLabel)}</h3><p>${esc(d.prepareValue)}</p></div>`;actions=next('生成预览');
    }else if(demo.step===1){
      content=`<div class="pt-demo-section"><h3>${esc(demo.task)} · ${esc(d.planTitle)}</h3>${detailList(d.planItems)}<p class="pt-demo-note">仅展示预设样例；确认后可查看本次任务的示例产出。</p></div>`;actions=next('确认并查看结果');
    }else{
      content=`<div class="pt-demo-result"><h3>${ico('circle-check')}${esc(d.resultTitle)}</h3><p>${esc(demo.task)} · 演示任务已完成</p></div><div class="pt-demo-section"><h3>示例产出</h3>${detailList(d.resultItems)}<p class="pt-demo-note">未连接业务系统，未修改实际项目或数据。</p></div>`;
      actions=`<button class="pt-button" data-demo-report>${ico('download')}下载示例报告</button><button class="pt-button pt-button-primary" data-demo-restart>新建示例任务</button>`;
    }
    $('#pt-platform-demo').innerHTML=`<div class="pt-demo-head"><h2 id="pt-demo-title">${esc(t.name)}<span class="pt-demo-badge">Mock 工作台</span></h2><a class="pt-link" href="./portal.html">返回AI应用广场${ico('arrow-up-right')}</a></div><div class="pt-demo-body"><ol class="pt-demo-progress" aria-label="使用流程">${steps.map((label,i)=>`<li data-step="${i+1}" ${i===demo.step?'aria-current="step"':''}>${label}</li>`).join('')}</ol>${content}<div class="pt-demo-footer"><span class="pt-demo-copy-state" id="pt-demo-message" role="status"></span><div class="pt-actions">${demo.step?'<button class="pt-link" data-demo-back>上一步</button>':''}${actions}</div></div></div>`;iconRender();
  }
  function downloadPlatformReport(){const {t,d}=platformDemoContext();if(!t||!d)return;const text=`# ${t.name} · 示例报告\n\n任务：${demo.task}\n\n材料：${d.prepareValue}\n\n## ${d.planTitle}\n${d.planItems.map(x=>'- '+x).join('\n')}\n\n## ${d.resultTitle}\n${d.resultItems.map(x=>'- '+x).join('\n')}\n\n所有内容均为 Mock 数据，未执行真实业务操作。\n`;const started=saveDemoFile(`${t.name}-示例报告.md`,new Blob([text],{type:'text/markdown;charset=utf-8'}));$('#pt-demo-message').textContent=started?'已发起示例报告下载。':'请在伏羲网页版下载示例报告。'}

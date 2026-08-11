## v0.1.99 — 2026-08-09

### Terminal

- **Shift+Enter escreve uma nova linha em vez de enviar.** Terminais não têm codificação para Enter com tecla modificadora, então CLIs de agentes como Claude Code e Codex recebiam apenas um retorno de carro comum e enviavam o texto enquanto ainda estava sendo escrito. Agora o VelaTerm emite ESC+CR, a mesma sequência que essas ferramentas esperam de um mapeamento de teclas do iTerm2, o que torna a entrada de várias linhas utilizável — inclusive no macOS, onde o tratador de teclas personalizado sequer era instalado. A composição em um método de entrada continua intacta: Enter ainda confirma o candidato.

### Projetos e organização

- **Atualizar o status de uma única sessão.** Em um painel com filtro de status, as sessões ganham a ação «Atualizar status», que reavalia somente aquela sessão segundo as condições do próprio painel, incluindo-a ou removendo-a enquanto todas as outras permanecem no lugar. A ação pertence ao painel de onde o menu foi aberto, de modo que divisões aninhadas nunca tomam emprestado o filtro de outro painel. O resultado é guardado por painel e restaurado após reiniciar.
- **Remover uma marca exige um clique.** Escolher o emoji já aplicado passa a removê-lo, então o item dedicado à remoção e seu separador foram retirados. O selo de emoji no botão de filtro também saiu: o destaque já mostra que há um filtro de marca ativo, e o menu mostra qual é.

### Correções

- **A integração de área de trabalho do AppImage do Linux instala em qualquer máquina.** O ícone incluído era um link simbólico para um caminho absoluto da máquina de compilação, de modo que ferramentas como Gear Lever e AppImageLauncher não conseguiam extraí-lo, embora o próprio aplicativo funcionasse normalmente. O link agora é relativo. O requisito de glibc divulgado também foi corrigido para 2.35 depois de medir as bibliotecas distribuídas junto, e não apenas o executável, o que torna o Ubuntu 22.04 a distribuição mais antiga compatível com o aplicativo de área de trabalho.

## v0.1.98 — 2026-08-02

### Agentes de IA

- **O Grok Build passa a ser um agente de primeira classe no VelaTerm.** Instale, inicie e retome o Grok 4.5 com IDs de sessão estáveis, lifecycle hooks oficiais, estados precisos de trabalho e permissão, transcrições unificadas, detalhes de uso e um ícone oficial que acompanha o tema nas visualizações de desktop, navegador e celular.

### Projetos e organização

- **Divida a barra lateral de projetos em visualizações de trabalho independentes.** Qualquer painel da árvore pode ser dividido novamente para baixo e restaura, após a reinicialização, sua própria pesquisa, filtros de status e emoji, estado de recolhimento e proporção de tamanho. Todos os painéis continuam sendo projeções da mesma árvore de projetos mantida pelo backend, portanto as edições ficam sincronizadas sem duplicar dados de negócio.
- **Marque e filtre nós sem perder o contexto.** Projetos, grupos e sessões podem receber marcadores de emoji. Um contêiner marcado mantém toda a sua subárvore visível, a associação de status permanece estável durante o trabalho, tanto a inclusão dinâmica quanto a atualização manual estão disponíveis, e as condições de status e emoji são combinadas como uma união.
- **Crie um projeto vazio no próprio lugar.** Escolha o diretório pai, valide o nome e crie e importe a pasta em um único fluxo. Se houver uma falha parcial, somente a importação será repetida, sem criar diretórios duplicados.

### Interface

- **Compartilhe o VelaTerm onde sua comunidade está.** A janela de compartilhamento agora inclui WeChat Moments, Weibo, Xiaohongshu, X, Reddit, Hacker News, LinkedIn, Facebook, Telegram e WhatsApp, com um fluxo por QR code para o WeChat e um convite para compartilhar na janela de atualização.
- **Pequenas interações ficaram mais cuidadosas.** As abas temporárias do terminal podem ser renomeadas antes de virarem sessões salvas. Os campos de entrada comuns desativam a capitalização automática dos teclados móveis sem alterar a entrada do terminal.

## v0.1.97 — 2026-07-25

### Agentes de IA

- **As sessões não ficam mais presas em “trabalhando”.** O Codex informava a atividade das ferramentas e o fim do turno por processos efêmeros separados, cujos callbacks podiam chegar fora de ordem e deixar um turno concluído exibido como ainda em execução. Agora os relatos intermediários que chegam após o fim do próprio turno são descartados, e um novo hook de fim de sessão cobre sessões que terminam sem evento de conclusão.
- **Turnos interrompidos se resolvem em segundos.** Pressionar Esc, ou um erro de streaming, encerra um turno do Claude ou do Codex sem nenhum callback de conclusão. Seis segundos de silêncio no terminal agora corrigem discretamente essa sessão para aguardando, sem gerar uma notificação de “respondeu”.

### Interface

- **Atalhos de divisão confiáveis no macOS.** Dividir à direita (Cmd+D) e dividir abaixo (Cmd+Shift+D) agora são registrados como comandos do menu Terminal nativo, de modo que o macOS não intercepta mais a combinação antes do VelaTerm.
- **Um salvamento por tecla pressionada.** O Cmd+S era tratado tanto pelo atalho global quanto pelo editor em foco, o que podia gravar o mesmo arquivo duas vezes em um único pressionamento.

## v0.1.96 — 2026-07-23

### Agentes de IA

- **O status do Codex confia em lifecycle hooks, não em suposições do terminal.** Sessões modernas do Codex agora usam apenas os lifecycle hooks oficiais como fonte de atividade. Um handshake `SessionStart` verifica a integração, callbacks ausentes aparecem como “Status indisponível” e o texto ou a atividade do terminal não pode mais sobrescrever estados de trabalho, confirmação ou conclusão.
- **Uso do Codex mais atualizado após cada turno.** O painel Info mostra imediatamente o snapshot rollout local, compara-o com os limites ao vivo, atualiza novamente depois que o Codex grava o snapshot token final e ignora respostas atrasadas de uma sessão anterior.

### Interface

- **Seleção confiável na árvore de projetos no macOS.** As linhas virtuais não dependem mais de transform do compositor, impedindo que coordenadas de hit-test obsoletas do WKWebView enviem ações de passar o mouse, clicar ou arrastar para outra linha após rolagem ou atualização da árvore.

## v0.1.95 — 2026-07-21

### Agentes de IA

- **Kimi Code e Zoo Code chegam à árvore de sessões.** O VelaTerm agora inicia, retoma, instala e configura os dois agentes. O Kimi usa lifecycle hooks oficiais para informar com autoridade os estados de trabalho, permissão e espera; o Zoo Code mantém uma identidade de tarefa estável e usa detecção do terminal quando não há hooks externos.
- **Atualização ao vivo do uso do Codex.** O painel Info consulta o Codex app server para obter os limites atuais e mantém o snapshot rollout local como fallback compatível.

### Projetos e terminais

- **Abra projetos com `vela <path>`.** Builds empacotadas podem instalar um comando shell no estilo do VS Code. Uma segunda chamada envia o projeto à janela VelaTerm existente, sem abrir uma instância duplicada.
- **Clone Git visível e cancelável.** Clone Project mostra etapas, porcentagem e tempo decorrido, alerta quando o progresso para e cancela toda a árvore de processos Git sem deixar um destino incompleto. Credenciais e query tokens são ocultados em erros e logs de auditoria.
- **Terminais WSL no Windows.** Todas as distribuições WSL instaladas aparecem ao lado de PowerShell, cmd e Git Bash para terminais comuns. Sessões de agentes continuam no shell host do Windows para manter hooks e caminhos de executáveis confiáveis.

### Interface e confiabilidade

- **Controle mais claro das sessões em segundo plano.** Os menus mostram o estado ao vivo de cada sessão e o diálogo de limite permite encerrar várias abas selecionadas de uma vez.
- **Ciclo de vida mais seguro e notas multilíngues.** Há confirmação antes de parar sessões ativas; a identidade lifecycle exata do Codex prevalece sobre scans rollout ambíguos; as notas de atualização suportam todos os idiomas incluídos.

## v0.1.94 — 2026-07-12

### Localização

- **Interface em vietnamita.** Tiếng Việt agora está disponível no seletor de idiomas e é selecionado automaticamente quando o sistema usa uma localidade vietnamita.

### Navegador

- **Inicialização mais rápida do navegador integrado.** Cada aba do navegador agora tem atalhos de um clique para ChatGPT, Claude, Gemini e Google. Os menus de contexto de projetos e grupos também podem criar uma página permanente do navegador diretamente na parte correspondente da árvore de sessões.

### Imagens e documentos

- **Colagem confiável de caminhos de imagem no macOS.** Quando o WebKit não expõe uma imagem copiada como arquivo, o VelaTerm passa a lê-la da área de transferência nativa e ainda a envia como caminho de arquivo, em vez de recorrer silenciosamente ao espaço reservado de imagem nativo do agente. As janelas remotas sempre exibem a configuração de colagem de imagens, explicam por que o modo de caminho de arquivo é necessário e desativam a opção nativa indisponível.
- **Colagem de imagens em documentos-fonte.** O editor de código-fonte agora aceita imagens da área de transferência. Documentos Markdown salvos armazenam as imagens ao lado do documento em `assets/` e inserem uma sintaxe de imagem Markdown portátil; rascunhos não salvos incorporam os dados da imagem para que eles não sejam perdidos na limpeza dos arquivos temporários.

### Interface

- **Os menus de contexto permanecem visíveis e apontam para o item correto.** Menus abertos perto da borda direita são medidos e reposicionados corretamente. Clicar com o botão direito em um nó da árvore agora destaca apenas o alvo do menu, sem alterar a seleção existente; os menus de grupo também incluem um terminal limitado àquele grupo.
- **Edição e rótulos de status mais limpos.** O texto-fonte não renderiza mais ligaduras de fonte em forma de seta para sequências como comentários HTML, as porcentagens de uso são explicitamente rotuladas como usadas e o menu de contexto nativo não relacionado do WebView hospedeiro não aparece mais atrás dos menus do VelaTerm.

### Correções

- **Codex permanece no histórico normal do terminal.** As sessões do Codex iniciadas pelo VelaTerm agora usam o modo de terminal inline. Assim, pressionar Esc para interromper ou voltar não alterna mais os buffers de tela do terminal nem leva a visualização do histórico para o topo. A configuração do Codex do usuário não é alterada.

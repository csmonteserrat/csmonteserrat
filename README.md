# Sistema de Chamada de Pacientes — Centro de Saúde Monte Serrat

Sistema web para chamada de pacientes na Atenção Primária (SUS), com duas telas sincronizadas em tempo real:

- **/painel** — usada pelo profissional no consultório (ou pela farmácia/recepção, por senha)
- **/tv** — exibida em tela cheia na TV da recepção, com anúncio em voz alta

Vários profissionais podem usar o /painel ao mesmo tempo, cada um da sua sala. A TV recebe todas as chamadas.

---

## 1. Requisitos

- Um computador da unidade que fique ligado durante o expediente (será o "servidor")
- [Node.js](https://nodejs.org) versão 18 ou superior instalado nesse computador
- TV com navegador (Smart TV com Chrome/navegador próprio, ou um computador/mini PC/Chromecast/Raspberry Pi ligado na TV)
- Todos os dispositivos na **mesma rede local** (cabo ou Wi-Fi da unidade)

## 2. Instalação

Abra o terminal (Prompt de Comando no Windows) na pasta do projeto e rode:

```bash
npm install
```

Isso só precisa ser feito uma vez.

## 3. Subir o servidor (comando único)

```bash
npm start
```

O terminal vai mostrar algo assim:

```
Sistema de Chamada — CS Monte Serrat
------------------------------------
Painel do profissional:  http://localhost:3000/painel
TV da recepção:          http://localhost:3000/tv

Na rede local, use um destes endereços nos outros dispositivos:
  http://192.168.0.15:3000/painel   |   http://192.168.0.15:3000/tv
```

O endereço com números (ex.: `192.168.0.15`) é o **IP local** da máquina servidora. É ele que você digita nos outros computadores e na TV.

### Como descobrir o IP local manualmente

Se precisar conferir o IP por fora do sistema:

- **Windows:** abra o Prompt de Comando e digite `ipconfig`. Procure "Endereço IPv4" (ex.: 192.168.0.15).
- **Linux:** digite `hostname -I` no terminal.
- **macOS:** Preferências do Sistema → Rede, ou `ipconfig getifaddr en0`.

Dica: no roteador da unidade, reserve um IP fixo para a máquina servidora (reserva DHCP). Assim o endereço nunca muda e os favoritos continuam funcionando.

Se o Windows perguntar sobre o firewall na primeira execução, permita o acesso em **redes privadas**.

## 4. Abrir as telas

- Em cada consultório: abra o navegador e acesse `http://IP-DO-SERVIDOR:3000/painel`. Salve nos favoritos. O cadastro do plantão (nome, categoria, sala) fica salvo no próprio navegador.
- Na TV da recepção: abra `http://IP-DO-SERVIDOR:3000/tv`. Sem código e sem botão: a tela já abre funcionando (a TV é somente-leitura; o código de acesso é exigido apenas no /painel). Se o navegador bloquear o som por política de autoplay, aparece um aviso discreto e um único toque em qualquer lugar libera; no modo quiosque do item 5 nem isso é necessário.

Na /tv, a tecla **c** (ou um toque no canto inferior direito) abre o menu de volume e velocidade da fala.

## 5. Fazer a /tv iniciar sozinha ao ligar

### Opção A — Computador/mini PC Windows ligado na TV

1. Crie um atalho do Chrome com este destino (ajuste o IP):
   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --autoplay-policy=no-user-gesture-required http://192.168.0.15:3000/tv
   ```
2. Pressione `Win + R`, digite `shell:startup` e Enter.
3. Copie o atalho para essa pasta. Ao ligar o computador, o Chrome abre direto na /tv em modo quiosque.

O parâmetro `--autoplay-policy=no-user-gesture-required` é o que permite a TV ligar já falando, sem nenhum toque. Sem ele, o navegador pode exigir um toque na tela para liberar o som (o sistema avisa quando for o caso).

### Opção B — Raspberry Pi ligado na TV

Edite o autostart do ambiente gráfico:

```bash
mkdir -p ~/.config/autostart
nano ~/.config/autostart/tv-chamada.desktop
```

Conteúdo (ajuste o IP):

```
[Desktop Entry]
Type=Application
Name=TV Chamada
Exec=chromium-browser --kiosk --autoplay-policy=no-user-gesture-required --noerrdialogs --disable-session-crashed-bubble http://192.168.0.15:3000/tv
```

### Opção C — Smart TV / TV Box Android

Instale um navegador com modo quiosque (ex.: "Fully Kiosk Browser"), configure a URL inicial como `http://IP-DO-SERVIDOR:3000/tv` e ative "iniciar com o sistema" nas opções do aplicativo.

### Manter o servidor sempre de pé (opcional, recomendado)

Na máquina servidora, o [PM2](https://pm2.keymetrics.io) reinicia o sistema sozinho se o computador reiniciar:

```bash
npm install -g pm2
pm2 start server.js --name chamada
pm2 save
pm2 startup   # siga a instrução que aparecer na tela
```

## 6. Rotina de uso

1. O profissional preenche o plantão uma vez (fica salvo) e chama pelo nome; a farmácia usa o modo por senha, com contador automático.
2. Cada chamada entra no histórico como **AGUARDANDO** e ocupa o destaque da TV enquanto é anunciada. Marcar **Em atendimento** (a pessoa entrou na sala), **Compareceu** ou **Faltante** tira a pessoa do destaque central e a move para a lista lateral, com a cor e o rótulo do status. Quando ninguém está sendo chamado, a TV mostra "Seu nome ou sua senha aparecerão nesta tela, aguarde".
3. Chamadas simultâneas de várias salas entram numa fila única, em ordem de chegada: cada uma ocupa a tela e o áudio na sua vez, sem sobreposição. O painel avisa em quanto tempo a chamada entra no ar, e a TV mostra quantas estão na fila. Com 3 ou mais aguardando, a frase é falada uma vez só (em vez de duas) para a fila escoar mais rápido.
4. Estados possíveis: Quando a pessoa comparece, clique **Compareceu** (verde). Se não vier, **Rechamar** repete o som e o destaque na TV; a partir da segunda chamada sem desfecho, a linha entra em alerta e o botão **Faltante** fica em evidência, mas a marcação é sempre decisão do profissional. Qualquer status pode ser corrigido depois.
5. O botão **Limpar histórico** apaga as chamadas da tela e da TV sem encerrar o turno, útil quando a lista fica longa demais no meio do expediente. Os registros sem nomes continuam indo para o histórico mensal.
6. Os botões **Exportar dia** e **Exportar mês** no histórico baixam CSVs sem nomes de pacientes (horário, sala, categoria, vezes chamado, status), para acompanhar absenteísmo e produção.
7. No fim do expediente, use **Encerrar turno** e confirme. O histórico com nomes é apagado de todos os dispositivos (LGPD); um registro **sem nomes** de cada chamada fica arquivado por 31 dias no histórico mensal do servidor.

O estado do turno é salvo em `estado-turno.json` na pasta do projeto, então uma queda de energia ou reinicialização do servidor não perde a fila do dia. Nomes de pacientes nunca ficam guardados além do turno atual.

## 7. O que aparece no lado esquerdo da TV

No painel, na aba "Avisos e mensagens", o cartão **"Conteúdo da TV"** escolhe entre dois modos, e a troca vale na hora para todas as telas. O padrão de fábrica é "Avisos e mensagens":

- **Vídeos educativos**: os vídeos do `videos.txt` tocando em sequência (detalhes abaixo).
- **Avisos e mensagens**: sem vídeo. O espaço passa os avisos ativos da unidade em rodízio, alternados com frases de orientação para quem espera ("Aguarde, seu nome aparecerá aqui em breve", "Mantenha seu cartão SUS e documento em mãos" etc.), trocando a cada 12 segundos. Útil em dias de reunião, quando falta internet para o vídeo, ou quando a equipe quer a recepção mais silenciosa.

As chamadas funcionam igual nos dois modos.

## 8. Vídeos educativos na TV

O lado esquerdo da TV exibe vídeos educativos em sequência contínua. A lista fica no arquivo **`public/videos.txt`**, um link do YouTube por linha (linhas em branco e linhas iniciadas por `#` são ignoradas). Ao terminar o último vídeo, a lista recomeça do primeiro. A TV relê o arquivo a cada 10 minutos, então mudanças entram sozinhas.

- A cada **1 minuto**, o vídeo ocupa a tela inteira por **10 segundos** e depois volta ao layout normal, com a lista lateral. Se chegar uma chamada durante esse período, a tela volta na hora ao normal: chamada sempre tem prioridade. Para mudar os tempos, procure `INTERVALO_CHEIO` e `DURACAO_CHEIO` em `public/tv.html`.
- O volume do vídeo fica fixo em **20%** do volume do aparelho. Ajuste o volume da TV pelo que fica bom para a chamada: o vídeo ficará bem mais baixo, como pano de fundo.
- Quando entra uma chamada, o vídeo **pausa**, o popup ocupa a tela com o nome e a sala, e o anúncio é falado. Terminado o anúncio, o popup some, o nome desce para a lista da direita e o vídeo **volta de onde parou**.
- Na lista da direita, quem ainda não teve desfecho fica **piscando**; quem foi marcado como em atendimento, compareceu ou faltante fica fixo, com a cor e o ícone do status.
- Para usar uma playlist inteira, use o link do botão **Compartilhar** do YouTube: links copiados da barra do navegador costumam vir com o código da playlist cortado. Se o código vier curto demais, o sistema ignora a playlist e toca os vídeos avulsos da lista.
- Vídeos cujo dono bloqueou a exibição em outros sites não tocam; o sistema pula para o próximo automaticamente.
- A TV tenta primeiro a API do YouTube e, se ela não carregar (comum em navegadores de Smart TV), cai sozinha para um player embutido mais simples. Para saber qual está em uso, toque no canto inferior direito da TV: o menu mostra a linha "Vídeo:".

## 9. A aba "Avisos e mensagens" do painel

O painel tem duas abas no topo. A segunda reúne tudo que aparece na TV além das chamadas:

- **Conteúdo da TV**: escolhe entre vídeos educativos e o modo de mensagens.
- **Avisos na TV**: recados da unidade, com ou sem áudio (detalhes abaixo).
- **Frases de orientação**: as mensagens genéricas que passam em rodízio no modo "Avisos e mensagens" ("Aguarde, seu nome aparecerá aqui em breve" e outras). Vêm seis prontas; dá para adicionar novas, desativar sem perder o texto, ou excluir.
- **Farmácia — medicamentos em falta**: lista de itens em falta, exibida na TV como um quadro próprio em roxo (para não se confundir com os avisos, que são âmbar), com o título "Medicamentos em falta:" e os itens listados um por linha, sem áudio. Acima de 5 itens a lista se divide em duas colunas; acima de 12, os excedentes viram "e mais N. Consulte a farmácia." O botão mostra se está no ar; "Limpar tudo" esvazia a lista de uma vez, no fim do dia ou quando o estoque normaliza.

No rodízio, a TV alterna uma frase de orientação e um destaque (aviso da unidade ou farmácia), para o recado importante não se perder entre as mensagens genéricas. Pontinhos embaixo do quadro indicam quantas mensagens estão circulando.

### Onde tudo isso fica guardado

Avisos, frases de orientação, lista da farmácia e o modo da tela ficam no arquivo **`conteudo-tv.json`**, separado do turno: **não são apagados** ao encerrar o turno nem quando o servidor reinicia. Só somem quando alguém exclui pelo painel.

Como o disco do Render é temporário no plano gratuito, o painel também guarda uma **cópia no navegador**. Se um deploy apagar o arquivo do servidor, o primeiro painel que abrir devolve a cópia automaticamente e avisa na tela. Para isso funcionar, vale abrir o painel sempre no mesmo computador da coordenação ao menos uma vez por dia.

## 10. Avisos e botão de emergência

**Avisos na TV**: no painel há um cartão "Avisos na TV" para cadastrar recados que aparecem numa faixa fixa no rodapé da TV. Cada aviso pode ser de dois tipos, alternáveis a qualquer momento pelo botão 🔊/🔇:
- **Falado**: além de aparecer na faixa, é lido em voz alta na frequência escolhida (de 10 minutos a 2 horas).
- **Estático**: aparece só escrito na faixa, sem áudio nenhum. Útil para informações permanentes (horário da farmácia, orientação de documentos) que não precisam interromper a recepção. O aviso de reunião de equipe já vem cadastrado e **desativado**: basta clicar em "Ativar" no dia da reunião e desligar depois. Os avisos entram na mesma fila das chamadas, então nunca falam por cima de um paciente sendo chamado. "Ler agora" dispara o aviso imediatamente.

**Botão de emergência (código Senhor Verde)**: o botão redondo no canto inferior direito do painel serve para situações de violência contra o profissional. Exige dois toques em até 5 segundos (evita disparo acidental) e então anuncia na TV, com prioridade sobre tudo e três repetições: "Atenção, Senhor Verde. Dirija-se ao [sala de quem acionou]". A chamada em curso é interrompida. O acionamento não entra no histórico de pacientes, mas fica registrado sem nomes no histórico mensal (categoria "Emergência"), para a unidade acompanhar.

**Janela flutuante do botão de emergência**: o botão menor (⇱) ao lado do botão de emergência abre uma janelinha só com o acionamento, que continua visível mesmo com o painel minimizado ou com outra aba em uso.

- No **Chrome ou Edge** (versão 116 ou mais recente), a janela usa Picture-in-Picture e fica **sempre por cima**, inclusive de outros programas como o prontuário eletrônico. É o cenário ideal.
- No **Firefox e Safari**, abre uma janela comum, que não fica automaticamente por cima. No Windows, dá para fixá-la usando um utilitário como o Microsoft PowerToys (atalho "Always on Top"); no Linux, clicando com o botão direito na barra de título e marcando "Sempre visível".

A janelinha mostra apenas o símbolo ⚠, para não chamar atenção de quem estiver na sala. O primeiro clique troca o símbolo por "Confirmar?"; o segundo clique aciona. Sem a confirmação em 12 segundos, ela volta sozinha ao símbolo. Usa o mesmo código de acesso do painel, então é preciso ter entrado no painel naquele navegador ao menos uma vez.

Combine com o protocolo da equipe: quem ouve o código na recepção precisa saber o que fazer. Vale treinar isso antes de colocar em uso.

## 11. A TV entra em protetor de tela

Smart TVs LG (WebOS) e Samsung ligam o protetor mesmo com a soneca desativada quando a página fica parada. A /tv se defende de quatro formas somadas: pede o Wake Lock ao navegador, mantém o relógio mudando a cada segundo e um ponto de 2px em movimento contínuo, reproduz um vídeo de 2px gerado internamente (mídia em reprodução costuma ser o que a TV mais respeita) e emite um som inaudível em looping.

Se ainda assim a tela apagar, verifique nas configurações da TV LG:
- **Geral → Economia de energia → Desligar tela automaticamente**: desativado
- **Geral → Temporizadores → Desligar após X horas**: desativado
- **Configurações de tela → Economia de energia → Modo automático**: desativado
- No navegador da LG, evite deixar a página em segundo plano com outro aplicativo aberto

## 12. Solução de problemas

- **A TV não fala (Smart TV):** navegadores de Smart TV não têm voz de síntese; o sistema resolve gerando a fala no servidor, o que exige o `espeak-ng` instalado na máquina servidora (`sudo apt install espeak-ng` no Linux) ou o runtime Docker no Render. Abra o menu da TV (tecla "c" ou toque no canto inferior direito) e use "Testar voz agora" para ver o status.
- **A TV não fala (computador):** veja se há o aviso "Toque em qualquer lugar da tela para liberar o som" (toque uma vez), confira se o volume da TV está alto e se o menu (tecla "c") não está com volume em 0%. Em Smart TVs muito antigas sem síntese de voz em português, use um mini PC ou TV Box.
- **"Sem conexão" no painel:** o servidor caiu ou o dispositivo saiu da rede da unidade. Verifique se `npm start` (ou o PM2) está rodando na máquina servidora.
- **O IP mudou:** configure reserva de IP no roteador (item 3) e atualize os favoritos.

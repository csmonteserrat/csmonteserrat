# Publicar on-line no Render (grátis) + UptimeRobot

Este guia coloca o sistema no ar com endereço fixo e HTTPS, acessível de qualquer rede. O UptimeRobot mantém o servidor acordado no plano gratuito do Render.

## Código de acesso

O **painel do profissional** pede um código de 6 números na primeira vez que é aberto (fica salvo no navegador). A **TV não pede código**: ela abre direto, em modo somente-leitura — o servidor ignora qualquer tentativa de chamada ou mudança vinda da rota da TV.

- Código padrão: **246810**
- **Troque o código** ao publicar (passo 3 abaixo), porque o padrão está neste arquivo e no código-fonte. Escolha 6 números fáceis para a equipe, mas não óbvios (evite 123456 e datas conhecidas da unidade).

Sem o código correto, ninguém consegue fazer chamadas, mudar status, encerrar turno ou exportar o histórico mensal. Como a TV abre sem código, quem tiver o endereço /tv consegue assistir às chamadas; trate a URL como informação interna da unidade e, se preferir reduzir a exposição, ative o modo de nome abreviado no painel.

## Passo 1 — Subir o código para o GitHub

1. Crie uma conta gratuita em github.com.
2. Clique em **New repository**, dê um nome (ex.: `chamada-monte-serrat`), marque **Private** e crie.
3. Na página do repositório, clique em **uploading an existing file** e arraste TODOS os arquivos e pastas do projeto (server.js, package.json, a pasta public com painel.html e tv.html, os README). Não envie a pasta `node_modules` nem `estado-turno.json`.
4. Clique em **Commit changes**.

## Passo 2 — Criar o serviço no Render

1. Crie uma conta em render.com (pode entrar com o GitHub, não precisa de cartão).
2. Clique em **New → Web Service** e conecte o repositório que você criou.
3. Preencha:
   - **Name**: chamada-monteserrat (isso vira o endereço)
   - **Region**: Ohio ou Virginia (mais próximas do Brasil entre as gratuitas)
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
4. Clique em **Create Web Service** e aguarde o primeiro deploy terminar.

Seu endereço será algo como:

```
https://chamada-monteserrat.onrender.com/painel
https://chamada-monteserrat.onrender.com/tv
```

## Passo 3 — Trocar o código de acesso

1. No painel do Render, abra o serviço e vá em **Environment**.
2. Clique em **Add Environment Variable**:
   - Key: `CODIGO_ACESSO`
   - Value: os 6 números que você escolheu
3. Salve. O Render reinicia o serviço sozinho com o código novo.

Para trocar o código no futuro (ex.: saída de um servidor da equipe), basta editar essa variável. Nos navegadores que tinham o código antigo salvo, a tela de código aparece de novo automaticamente.

## Passo 4 — UptimeRobot (manter acordado)

O plano gratuito do Render "dorme" após 15 minutos sem acesso e demora para acordar. O UptimeRobot resolve visitando o sistema a cada 5 minutos:

1. Crie uma conta gratuita em uptimerobot.com.
2. Clique em **New Monitor**:
   - **Monitor Type**: HTTP(s)
   - **Friendly Name**: Chamada Monte Serrat
   - **URL**: `https://SEU-ENDERECO.onrender.com/ping`
   - **Monitoring Interval**: 5 minutes
3. Salve.

A rota `/ping` existe exatamente para isso: é leve e não exige código de acesso. De bônus, o UptimeRobot avisa por e-mail se o sistema cair.

Opcional: em **Maintenance Windows** dá para pausar o monitor fora do expediente (ex.: 20h às 6h). O servidor dorme de madrugada, quando ninguém usa, e economiza as horas gratuitas do Render. Nesse caso a primeira abertura de manhã pode demorar ~1 minuto para acordar.

## Passo 5 — Usar

- Consultórios: abrir `https://SEU-ENDERECO.onrender.com/painel`, digitar o código uma vez, preencher o plantão. O filtro **Minhas/Todas** no histórico mostra só as chamadas da própria sala ou de todas.
- TV da recepção: abrir `https://SEU-ENDERECO.onrender.com/tv`. Sem código, sem botão: abre já funcionando. Com o modo quiosque do README principal (flag de autoplay), nem toque para liberar o som é preciso.
- Os botões **Exportar dia** e **Exportar mês** baixam CSVs sem nomes. Atenção: no Render gratuito o disco é temporário, então o histórico mensal pode zerar quando houver deploy ou reinício do serviço. Se o acompanhamento mensal for importante, crie o hábito de exportar o CSV toda sexta-feira, ou considere o plano pago com disco persistente.

## Se precisar recriar o serviço com Docker

O Render **não deixa trocar o runtime pelo painel** (só por API ou Blueprint). Se o `/tts-status` indicar que não há voz disponível, o caminho é recriar o serviço:

1. No serviço atual: **Settings → Delete Service** (anote antes o valor de `CODIGO_ACESSO`).
2. **New → Web Service**, conecte o mesmo repositório e use **o mesmo Name** de antes, para o endereço continuar igual.
3. Em **Language**, escolha **Docker**. Instance Type: Free.
4. Recrie a variável `CODIGO_ACESSO` em Environment.
5. Ajuste o monitor do UptimeRobot se o endereço mudar.

O `Dockerfile` já está na raiz do projeto e instala o sintetizador de voz automaticamente.

## Voz nas Smart TVs

Navegadores de Smart TV (LG WebOS, Samsung Tizen) normalmente **não têm vozes de síntese**, então o anúncio sairia só com o bipe. Por isso o servidor gera a fala em português e a TV apenas toca o áudio, como toca o bipe.

O servidor tenta, nesta ordem:
1. **espeak-ng** instalado na máquina (voz robótica, funciona offline) — disponível quando o serviço roda com Docker ou num computador da unidade com `sudo apt install espeak-ng`.
2. **Voz online do Google Tradutor** (voz natural, exige internet no servidor) — reserva automática quando o espeak não existe. É um endpoint público não oficial, então pode falhar ou limitar em uso intenso; o áudio de cada frase fica em cache para reduzir chamadas.

Confira qual está em uso abrindo `https://SEU-ENDERECO.onrender.com/tts-status`.

A TV escolhe sozinha o melhor caminho: usa a voz do navegador quando existe (som mais natural, em computadores) e cai para a voz do servidor quando não existe. Para conferir qual está em uso, abra o menu da TV (tecla "c" ou toque no canto inferior direito) e veja a linha de status, ou use o botão "Testar voz agora".

## Avisos importantes

- **Disco temporário**: o Render gratuito apaga arquivos gravados quando o serviço reinicia ou recebe um deploy novo. Na prática, se o serviço reiniciar no meio do expediente, o histórico daquele turno se perde (as telas continuam funcionando; só a lista zera). É raro, e como o sistema já apaga tudo no fim do turno por LGPD, é um risco aceitável. Se um dia incomodar, o plano pago do Render tem disco persistente.
- **Horas gratuitas**: o plano Free dá 750 horas por mês por conta, o que cobre um serviço ligado 24h por dia. Com a janela de manutenção do UptimeRobot, sobra folga.
- **Atualizar o sistema**: qualquer arquivo alterado no repositório do GitHub gera um deploy automático no Render.

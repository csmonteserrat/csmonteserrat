# Indicadores Saúde Bucal · versão 2.14

Ferramenta estática para leitura de relatórios do CELK e consolidados do Metabase, com organização mensal e quadrimestral dos indicadores municipais, federais e 2I de gestantes.

## Privacidade e funcionamento

- A leitura de PDF/CSV, os cálculos e a geração dos painéis acontecem no navegador.
- Os arquivos importados não são enviados ao GitHub, ao Render ou a uma API.
- **Os dados ficam salvos neste navegador** (IndexedDB) e voltam quando você reabre o app, a partir da versão 2.13. O salvamento pode ser desligado em Configurações → Privacidade e salvamento. Ele vale só para este computador e este perfil de navegador. A amostra bruta dos arquivos importados (linhas originais, com nomes) não é gravada: só existe enquanto a aba está aberta.
- **Para levar os dados a outro computador, exporte um backup.** O ícone no topo e o texto ao lado do contador de snapshots mostram quando foi a última gravação no navegador e o último backup exportado.
- **"Limpar dados do navegador"** apaga tudo o que o app guardou neste navegador. Antes, pergunta se você quer salvar um backup. Em computador compartilhado, use essa opção ao terminar.

O projeto não possui backend, banco de dados remoto ou serviço de telemetria. O PDF.js necessário para ler os relatórios já está incluído em `assets/`.

## Prioridade das fontes

- Quando houver dados do CELK para o mês, eles são usados no cálculo.
- O consolidado do Metabase permanece como referência de conferência.
- Divergências entre CELK e Metabase são apresentadas nos cards, na reconciliação e no diagnóstico.
- O Metabase só fornece o resultado ativo quando não há relatório CELK aplicável para aquela competência.

## Gestantes (2I)

- A lista vem do CSV de gestantes do Metabase e, opcionalmente, da lista "Gestante e Puérpera" do **Monitora APS**.
- Do Monitora APS só se usam **Equipe**, **Usuária** e **Cons.Odonto**. A Usuária é o número do prontuário do CELK:
  - Quando bate com uma gestante já guardada, ela é vinculada, e "Cons.Odonto = Sim" conta como atendida.
  - Sem correspondência, ela entra como "Dados a completar".
  - Quem está em **Puerpério** não entra, e quem já estava na lista sai dela (de forma reversível).
- O relatório de produção **Procedimentos Detalhado** do CELK traz o paciente como "( código ) NOME". Esse código é o mesmo número do prontuário. Um atendimento da equipe de saúde bucal **dentro da gestação** (da DUM até o parto ou hoje; sem DUM, nos últimos 300 dias) conta a gestante como atendida. A atividade educativa em grupo não conta.
- Ao importar a produção (CSV ou PDF), o app guarda um **cadastro de pacientes** (código do CELK → nome). Com ele, o nome é preenchido automaticamente nas listas anonimizadas, como a do Monitora APS, e no cadastro manual de gestante ao digitar o prontuário. Esse cadastro vai no backup completo, mas não no analítico.
- Os dados completados à mão ficam guardados pelo número da Usuária. Se ela aparecer depois no CSV do Metabase, migram para esse registro sem sobrescrever o que o Metabase traz.

## Publicar no Render

1. Crie um repositório no GitHub e envie todo o conteúdo desta pasta para a raiz da branch `main`.
2. No Render, escolha **New > Blueprint** e conecte o repositório.
3. O arquivo `render.yaml` cria o site estático e publica automaticamente cada novo commit.

Também é possível escolher **New > Static Site** e usar:

- Build Command: `echo "Site estático pronto"`
- Publish Directory: `.`

## Publicar no GitHub Pages

1. Envie os arquivos para a branch `main`.
2. Abra **Settings > Pages** no repositório.
3. Em **Source**, selecione **GitHub Actions**.
4. O workflow incluído em `.github/workflows/pages.yml` fará a publicação.

## Rodar localmente

Não abra `index.html` diretamente por `file://`, porque navegadores podem bloquear os módulos usados na leitura dos PDFs. Na pasta do projeto, inicie um servidor HTTP:

```bash
python3 -m http.server 8080
```

Depois acesse `http://localhost:8080`.

## Estrutura

- `index.html`: interface principal.
- `assets/app.js`: importação, normalização, cálculos e navegação.
- `assets/app.css`: apresentação visual responsiva.
- `assets/pdf.min.js` e `assets/pdf.worker.min.js`: leitor local de PDF (extensão `.js`, não `.mjs` — nem todo host estático serve `.mjs` com o Content-Type de JavaScript, e o navegador bloqueia a importação do módulo quando isso acontece).
- `render.yaml`: configuração do Render.
- `.github/workflows/pages.yml`: publicação automática no GitHub Pages.

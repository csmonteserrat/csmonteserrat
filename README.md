# Indicadores Saúde Bucal · versão 2.3

Ferramenta estática para leitura de relatórios do CELK e consolidados do Metabase, com organização mensal e quadrimestral dos indicadores municipais, federais e 2I de gestantes.

## Privacidade e funcionamento

- A leitura de PDF/CSV, os cálculos e a geração dos painéis acontecem no navegador.
- Os arquivos importados não são enviados ao GitHub, ao Render ou a uma API.
- **O navegador não salva nada.** Desde a v1.13, nada fica gravado em IndexedDB, localStorage ou qualquer outro armazenamento do navegador — o estado só existe na memória da aba enquanto ela está aberta. Fechar ou recarregar a página sem exportar um backup apaga tudo, sem aviso além do próprio alerta de "sair sem salvar" do navegador.
- **Exporte um backup para salvar de verdade**, sempre que quiser preservar o trabalho — é o único jeito. Um ícone vermelho no topo da tela (e o texto ao lado do contador de snapshots) avisam quando há alteração ainda não exportada. Para continuar de onde parou numa próxima abertura, restaure esse backup ("Restaurar backup anterior", disponível assim que a ferramenta abre sem dados).

O projeto não possui backend, banco de dados remoto ou serviço de telemetria. O PDF.js necessário para ler os relatórios já está incluído em `assets/`.

## Prioridade das fontes

- Quando houver dados do CELK para o mês, eles são usados no cálculo.
- O consolidado do Metabase permanece como referência de conferência.
- Divergências entre CELK e Metabase são apresentadas nos cards, na reconciliação e no diagnóstico.
- O Metabase só fornece o resultado ativo quando não há relatório CELK aplicável para aquela competência.

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

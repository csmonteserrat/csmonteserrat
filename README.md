# Acompanhamento Odontológico · versão 2.50

Ferramenta estática para leitura de relatórios do CELK e consolidados do Metabase, com organização mensal e quadrimestral dos indicadores municipais, federais e 2I de gestantes.

## No celular

- Abaixo de 760 px de largura o app troca a barra lateral por uma barra de navegação embaixo (Início, Gestantes, PSE, Indicadores e Mais) e mostra o cabeçalho numa linha: título, chip do período e menu ⋮ (Importar, Backup, Buscar).
- O período (ano, quadrimestre, mês e unidade) abre numa folha que sobe de baixo. No Início aparece "Precisa de atenção" (gestantes no 3º trimestre sem atendimento e vínculos a definir no PSE).
- Abas ficam presas no topo e rolam para o lado; tabelas do PSE viram cartões; botões têm pelo menos 40–44 px.
- As gavetas ocupam a tela toda, com "Registrar" e a ação principal presos no rodapé.
- No computador nada muda.

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
- Divergências entre CELK e Metabase aparecem no Diagnóstico.
- O Metabase só fornece o resultado ativo quando não há relatório CELK aplicável para aquela competência.

## Indicadores municipais e federais

- As páginas **Municipal** (M1–M5) e **Federal** (B1–B6) mostram o quadrimestre numa matriz: uma linha por indicador, os 4 meses, o resultado do quadrimestre e o que falta. Clicar numa linha abre a gaveta com a conta, o mês a mês e o que entrou no numerador e no denominador.
- **Resultado do quadrimestre**:
  - M1, M3, B1 e B4: média dos 4 meses (mês sem dado conta como 0%). O denominador é de população, então não se soma mês a mês.
  - Os demais: soma dos numeradores e dos denominadores dos meses com dado. Na leitura federal é um cálculo de conveniência, porque as Notas não definem como consolidar o quadrimestre.
- B1, B2, B4, B5 e B6 usam os mesmos números de M1, M2, M3, M4 e M5; muda só a faixa. M4 e B5 usam no denominador a lista de 28 códigos SIGTAP da Nota B5. B3 usa a lista de códigos da Nota B3.
- Na página Federal, "Para subir de faixa" mostra quantos procedimentos faltam para a próxima faixa. Na B3 (exodontia), a ferramenta nunca recomenda produzir exodontias: mostra quanto o restante da produção precisaria crescer.

## Procedimentos

- **Individuais**: número de procedimentos, pacientes atendidos, dias de atendimento e procedimentos por atendimento; "O que foi feito" por categoria clínica (Preventivos, Periodontia, Restauradores, Endodontia, Cirurgia e Outros), com nome, SIGTAP e em que indicador cada procedimento entra; mês a mês e por dentista (clicar filtra); pacientes por mês, quantas vezes cada um veio, idade e sexo. Clicar num procedimento abre a gaveta com mês a mês, dentista, idade e sexo.
- **Atividades coletivas**: atividades, participantes, crianças que entram em M3/B4 e crianças com avaliação alterada; cada atividade mostra quantos ficaram fora da faixa de 6 a 11 anos e, na gaveta, a lista de quem teve avaliação alterada (o backup analítico não leva os nomes).
- Período: mês, quadrimestre ou ano, a partir do filtro do topo. Filtros de dentista, idade e sexo.

### Análise estatística (aba da página Procedimentos)

- Três bases, sempre uma linha por pessoa e sem nome: **pacientes da produção** (Procedimentos Detalhado), **gestantes** (Monitora APS, lista mais recente; sem data, então o período não se aplica) e **crianças das escovações** (uma linha por participação; conta todos e avisa quantos estão fora da faixa de 6 a 11 anos de M3/B4).
- Variáveis dos pacientes: sexo, faixa etária, idade, dentista principal, mais de um dentista, mês e quadrimestre de entrada, 1ª consulta, concluiu (só quem teve 1ª consulta), concluiu no mesmo dia (só quem concluiu), voltou, urgência, preventivo, restauração, exodontia, periodontia, ART, voltou no quadrimestre seguinte, dias de atendimento, nº de procedimentos, dias até a conclusão, nº de dentistas e "Teve o procedimento…" (qualquer procedimento vira Sim/Não).
- Testes: qui-quadrado (ou Fisher), intervalo de confiança de Wilson, duas proporções (z ou Fisher), tendência de Cochran-Armitage, Mann-Whitney/Kruskal-Wallis, Spearman e **regressão logística** (razão de chances ajustada e "sozinho", IC de Wald, R² de McFadden, aviso de poucos casos por coeficiente e de categoria instável).
- É possível juntar categorias e analisar só um subgrupo. Com menos de 20 pessoas (30 na regressão) o teste não roda.
- **Baixar dados para análise** gera o CSV (separado por ";", UTF-8) com as variáveis do período e subgrupo da tela, mais um script R com o dicionário das variáveis e o código que refaz o teste. Por padrão, o nome dos dentistas vira Dentista A, B, C…
- A explicação de cada variável (de que coluna do relatório vem e como é calculada) está em [docs/analise-estatistica-variaveis.md](docs/analise-estatistica-variaveis.md).
- Arquivos importados antes da versão 2.28 não têm os dados por pessoa: importe de novo para que entrem na análise.

## PSE (avaliações nas escolas)

- Importa o CSV exportado da ferramenta de avaliação do PSE (Nome, Escola, Ano, Turma, Nascimento, CPF, Status Bucal, Lesões cariosas cavitadas, Necessidade de exodontia, Risco, Conduta, ART…). Os arquivos se somam: cada importação vira uma campanha, e a mesma criança é reconhecida pelo CPF ou por nome + nascimento. Só fica de fora quem está pendente no Status Bucal e no Status ART; preenchida em uma das duas, a criança entra. A data da avaliação vem do "Editado por … em".
- **Panorama**: todas as avaliações do período escolhido, de qualquer CS (avaliadas, risco alto, dor, lesões cavitadas, exodontia, dentes de ART, risco por turma). Crianças que participaram só da ação ou avaliação de ART (parte bucal pendente ou vazia e Status ART preenchido) ficam fora dos gráficos de risco e aparecem no card "Só ação de ART", por turma.
- **Meus alunos**: você marca quem é da sua área adscrita. Só eles vão para o **Acompanhamento** (A contatar, Em contato, Agendada, Atendida), com WhatsApp, bilhete pela escola, busca ativa, agendamento e notas.
- **Cruzamento com o CELK**, só com dado igual: atividade coletiva (Relação das Atividades em Grupo) por CPF ou nome + nascimento, trazendo CPF, CNS e sexo; produção (Procedimentos Detalhado) por nome igual e idade no atendimento igual à calculada pelo nascimento, trazendo o prontuário e todos os atendimentos. Nome ou nascimento diferente, idade que não confere ou dois prontuários com o mesmo nome ficam em **Vínculos a definir**. Quando aparece atendimento no prontuário depois da avaliação, a criança vira "Atendida" sozinha. Um dia só com orientação de higiene bucal + aplicação tópica de flúor (mesmo registrado como atendimento ou urgência) é o lançamento do flúor feito na escola e não conta. A fila de acompanhamento filtra por uma ou mais equipes.
- A gaveta da criança tem Acompanhamento (registros feitos por você podem ser removidos, com desfazer), Histórico (todos os atendimentos do prontuário com os procedimentos e o dentista, as escovações e as avaliações do PSE; registros com o mesmo nome ainda não ligados aparecem à parte), Cruzamento CELK e Dados cadastrais editáveis (equipe, responsável, telefone, endereço, CPF, CNS, prontuário).
- A base **Crianças do PSE** entra na análise estatística. Nome, CPF e contato ficam só no navegador e no backup completo; o backup analítico sai sem o PSE.
- Relatórios de atividades em grupo importados antes da versão 2.29 precisam ser importados de novo para entrar no cruzamento.

## Configurações

- **Geral**: salvamento no navegador e backup em arquivo (com a situação de cada um), denominadores de M1/B1 e M3/B4 com botão para editar, e "Sobre" (versões, regras e passo a passo).
- **Arquivos**: importação e a lista de arquivos agrupada por tipo, com o estado de cada um (em uso, somado ou substituído). "Conferir" abre a gaveta do arquivo: o que ele trouxe, onde entra no cálculo, avisos, linhas lidas e detalhes técnicos. O botão da lixeira exclui o arquivo: os dados dele saem de todos os cálculos e, se ele tinha substituído um arquivo do mesmo período, o anterior volta a valer.
- **Verificação**: primeiro o que precisa de ação, depois as informações dos arquivos, os limites das fontes e os testes internos.
- **Conferência por procedimento**: quanto de cada procedimento foi lido, excluído e validado no mês, e em que indicador entra, com exportação em CSV.

## Gestantes (2I)

- A lista vem do CSV de gestantes do Metabase e, opcionalmente, da lista "Gestante e Puérpera" do **Monitora APS**. **Cada novo arquivo é somado aos anteriores**:
  - A mesma gestante não duplica, e o dado mais recente atualiza o que mudou.
  - "Sim" em consulta odontológica não volta para "Não".
  - Quem não veio no arquivo novo é mantida.
- Do Monitora APS só se usam **Equipe**, **Usuária** e **Cons.Odonto**. A Usuária é o número do prontuário do CELK:
  - Quando bate com uma gestante já guardada, ela é vinculada, e "Cons.Odonto = Sim" conta como atendida.
  - Sem correspondência, ela entra como "Dados a completar".
  - Quem está em **Puerpério** não entra, e quem já estava na lista sai dela (de forma reversível).
- O relatório de produção **Procedimentos Detalhado** do CELK traz o paciente como "( código ) NOME". Esse código é o mesmo número do prontuário. Um atendimento da equipe de saúde bucal **entre a DUM e a DPP** (ou até o parto, se ele veio antes) conta a gestante como atendida. Sem DUM e sem DPP, o atendimento do CELK não conta: complete a data (filtro "Dados incompletos"). A atividade educativa em grupo não conta.
- Ao importar a produção (CSV ou PDF), o app guarda um **cadastro de pacientes** (código do CELK → nome). Com ele, o nome é preenchido automaticamente nas listas anonimizadas, como a do Monitora APS, e no cadastro manual de gestante ao digitar o prontuário. Esse cadastro vai no backup completo, mas não no analítico.
- Os dados completados à mão ficam guardados pelo número da Usuária. Se ela aparecer depois no CSV do Metabase, migram para esse registro sem sobrescrever o que o Metabase traz.

## Crianças

- Crianças de **0 a 12 anos** da área: CSVs do **Metabase** de crianças até 2 anos (desenvolvimento infantil e vacinação, juntados pelo prontuário), crianças atendidas no **CELK** nos últimos 2 anos e os alunos marcados em "Meus alunos" no **PSE**. Atividades coletivas não puxam crianças.
- Dos CSVs do Metabase o app guarda só o essencial: prontuário (Cd Usu Cadsus ou Cd Usu Cadsus Normalizado, com a vírgula de milhar corrigida), Dt Nascimento, Nm Usuario, Nm Mae (responsável), telefones, Ds Endereco e Bairro, Cd Equipe, Sg Sexo e Ts Atualizacao. Vacinas, puericultura e último atendimento na APS são ignorados.
- Subabas por idade (0 a 2, 3 a 5, 6 a 12); fila e cor do card iguais às da Classificação de Risco; bebês de até 2 anos sem atendimento odontológico aparecem com "Bebê sem 1ª consulta odontológica". Quem sai da lista do Metabase por fazer 2 anos continua na aba até os 12 anos.

## Idosos

- A lista vem do CSV de idosos do **Metabase** (formato atual): Cd Usu Cadsus (prontuário do CELK), Cd Equipe, Nr Idade Fim, Ts Atualizacao, Nm Usuario, Sg Sexo, Ds Endereco e os telefones (celular primeiro). As colunas de consulta médica, peso e vacina são ignoradas. Cada CSV se soma aos anteriores; o mais recente pelo Ts Atualizacao atualiza o que mudou, e quem não vier no último arquivo fica com o aviso "Não veio no último arquivo".
- O CSV no **formato antigo** (com Data Nascimento) só completa a data de nascimento (e o nome, endereço ou telefone que faltar) de quem já está na lista atual. Ninguém entra na lista por ele. O prontuário com vírgula de milhar ("428,561") é corrigido.
- Subabas: **Todos os idosos**, **ILPI** e **Acamados e restritos ao domicílio**. Fila: A contatar, Em contato, Agendado, Em tratamento e Em dia, com a mesma regra da Classificação de Risco (os registros valem nas duas). O percentual do topo conta quem está em tratamento ou em dia (atendimento nos últimos 2 anos).
- Cor do card = faixa da Classificação de Risco; a etiqueta mostra a etapa.
- ILPI: o **Asilo Irmão Joaquim** é reconhecido pela Av. Mauro Ramos, 901, com qualquer complemento. Endereços com ASILO, LAR, REPOUSO, ILPI ou CUIDADOS no complemento viram sugestão para confirmar (criar ILPI, juntar a uma existente ou "Não é"). Na gaveta dá para marcar ou tirar uma pessoa da ILPI.
- Situação na gaveta (Nenhuma, Acamado, Restrito ao domicílio): leva a pessoa para a subaba e vale como C05 automático na Classificação de Risco.
- Os idosos entram sempre na Classificação de Risco (origem "Idoso"), com a idade do Metabase quando não há data de nascimento.

## Condições de saúde

- Pessoas com **hipertensão** e **diabetes** (listas do Metabase) e com **imunossupressão** ou **deficiência** (marcadas pela equipe na gaveta, com o tipo como etiqueta: deficiência física, visual, auditiva, intelectual, psicossocial, TEA, múltipla ou outra; imunossupressão por HIV/aids, quimio ou radioterapia, transplante, imunossupressor ou outra).
- Qual lista é cada CSV sai das colunas: a de diabetes tem hemoglobina glicada (Fl Hba1c) e avaliação dos pés; a de hipertensão não tem. Só prontuário, nome, telefones, endereço, equipe, sexo e data de atualização são guardados. As listas não trazem idade.
- Tudo vale na Classificação de Risco (B04 diabetes, B05 hipertensão, B06 imunossupressão, B07 deficiência), e as pessoas das listas entram nela sempre. As etiquetas de condição aparecem também nos cards da Classificação de Risco, Idosos e Crianças.

## Classificação de Risco (busca ativa)

- Aplica o **Protocolo de Estratificação de Risco para o Acesso à Saúde Bucal** (CS Monte Serrat, v2.0) a todas as pessoas da área: cadastro de pacientes do CELK (quem aparece no Procedimentos Detalhado com atendimento nos últimos 2 anos), gestantes, alunos marcados em "Meus alunos" no PSE e pessoas incluídas à mão. A mesma pessoa é juntada pelo prontuário.
- Total = condição clínica mais grave (0 a 40) + formulário (0 a 12) + ciclo de vida e vulnerabilidade social (teto de 40). Sinal de alarme = Vermelho; dor aguda, abscesso e trauma recente ficam no mínimo em Laranja; outras agudas, lesão suspeita e consequência da cárie sem dor, no mínimo em Amarelo. Verde: 35 pontos ou mais; Azul: 15 a 34; Violeta: menos de 15.
- Automáticos: idade (pelo nascimento ou, sem ele, pela idade no atendimento do CELK), gestante ativa, nunca consultou (C18) e mais de 2 anos sem consulta (C11) pela produção do CELK, e C10 pelo endereço. A avaliação do PSE sugere a condição clínica (3 ou mais lesões cavitadas ou exodontia = A09a; 1 a 2 = A09b), que o dentista confirma ou troca. Os demais critérios são marcados à mão na gaveta, até haver importação do cadastro e o formulário de pedido de atendimento.
- **C10**: em Florianópolis não há microárea. Na subaba "Escala de risco" você escreve as ruas de alta vulnerabilidade (ou marca a área inteira); a comparação com o endereço ignora acento, número e o tipo do logradouro.
- Fila: A contatar, Em contato, Agendada, **Em tratamento** e **Em dia**, pelo CELK dos últimos 2 anos. Em dia: tratamento concluído nos últimos 2 anos (atendimentos até 12 meses depois do concluído são manutenção); volta para a busca ativa 2 anos depois do concluído. Em tratamento: 1ª consulta ou atendimento nos últimos 2 anos sem concluído depois; sem atendimento há mais de 6 meses aparece como "possível abandono". Ordem: faixa, total, pontos clínicos, tempo sem consulta e idade.
- Gaveta por pessoa: Classificação (conta aberta, critério por critério, com a origem), Histórico odontológico (atendimentos do CELK, atividades coletivas, avaliações do PSE, gestação e registros), Acompanhamento e Dados cadastrais.
- Subaba "Escala de risco": todos os critérios com pontos, nível de evidência, fonte do dado, pergunta do formulário e quantas pessoas têm cada um; ruas do C10; distribuição × meta da pilotagem; regras de cálculo.
- O backup analítico não leva os dados das pessoas da classificação (só a lista de ruas do C10).

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

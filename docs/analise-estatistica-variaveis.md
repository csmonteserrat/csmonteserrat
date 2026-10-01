# Análise estatística: de onde vem cada variável

Este documento explica, variável por variável, **qual dado bruto dos relatórios** o app usa e **como ele vira o valor** que entra nos testes da aba *Procedimentos → Análise estatística*. Vale para a versão 2.33.

## Antes de tudo: as variáveis não mudam de teste para teste

As variáveis pertencem à **base** escolhida em "Quem entra na análise", não ao teste. São quatro bases, e cada uma tem sua lista fixa de variáveis:

| Base | Uma linha por | Relatório de origem |
|---|---|---|
| Pacientes da produção | paciente (código do CELK) | CELK · Procedimentos Detalhado (CSV ou PDF) |
| Gestantes (Monitora APS) | usuária do Monitora | Monitora APS · lista de gestantes e puérperas |
| Crianças das escovações | participação em escovação supervisionada | CELK · Relação das Atividades em Grupo (CSV) |
| Crianças do PSE | avaliação de uma criança numa campanha | CSV exportado da ferramenta de avaliação do PSE |

O que muda de um teste para outro é **o tipo de variável que cada campo aceita**. Por isso a lista de opções muda quando você troca de teste. Cada variável tem um de quatro tipos:

| Tipo | O que é | Exemplo |
|---|---|---|
| **Sim/Não** | duas respostas | Teve urgência |
| **Categoria** | grupos sem ordem | Dentista principal, Equipe |
| **Ordem** | grupos com ordem natural | Faixa etária, Risco (baixo → médio → alto) |
| **Número** | contagem ou medida | Idade, Dias de atendimento |

| Teste | Campo 1 aceita | Campo 2 aceita |
|---|---|---|
| Duas características estão relacionadas? (qui-quadrado ou Fisher) | Sim/Não, Categoria ou Ordem | Sim/Não, Categoria ou Ordem |
| Qual a porcentagem, com margem de erro? (IC 95% de Wilson) | Sim/Não | Sim/Não, Categoria ou Ordem (opcional) |
| Dois grupos têm porcentagens diferentes? (duas proporções) | Sim/Não | Sim/Não, Categoria ou Ordem (e você escolhe os 2 grupos) |
| A porcentagem sobe ou desce com a ordem? (tendência de Cochran-Armitage) | Sim/Não | só Ordem |
| Um número é diferente entre grupos? (Mann-Whitney ou Kruskal-Wallis) | Número | Sim/Não, Categoria ou Ordem |
| Dois números andam juntos? (Spearman) | Número | Número |
| O que explica um resultado? (regressão logística) | Sim/Não (o resultado) | vários fatores de qualquer tipo |

## Regras que valem para todas as bases

- **"Só para…" (valor vazio).** Algumas variáveis só existem para parte das pessoas. Por exemplo, "Concluiu no mesmo dia" só existe para quem concluiu o tratamento. Para as demais o valor fica vazio e a pessoa sai **daquele teste**; o app mostra quantas saíram. No CSV exportado, essa célula fica em branco.
- **Juntar categorias.** Quando você junta, por exemplo, "40–59" com "60+", o app troca o valor das duas por "40–59 + 60+" antes de rodar o teste. No CSV exportado, isso vira uma coluna extra terminada em `_juntas`.
- **Subgrupo.** "Analisar só um subgrupo" filtra as linhas antes do teste (exemplo: só quem tem sexo = Feminino).
- **Mínimo de dados.** Com menos de 20 linhas o teste não roda. Na regressão logística, o mínimo é 30.
- **Regressão logística.** Em cada fator Sim/Não, a referência é "Não". Nos fatores com categorias, a referência é a primeira categoria da ordem. A idade entra "a cada 10 anos"; os outros números entram "a cada 1 a mais".
- **Sem nome.** Nenhuma base tem nome, CPF, CNS ou telefone. O CSV exportado só tem um número sequencial em `id`.

---

## 1. Pacientes da produção

**Relatório:** CELK · *Procedimentos Detalhado*.
**Colunas brutas usadas:** `PACIENTE` (só o código entre parênteses, por exemplo `( 2073690 )`; o nome é descartado), `Idade`, `Sexo`, `Data`, `Profissional`, `Procedimento` e `Quantidade`.
**Quem entra:** todo paciente com pelo menos um registro nos meses do **período escolhido** (Mês, Quadrimestre ou Ano, a partir do filtro do topo) e da unidade escolhida. Se o mesmo mês foi importado mais de uma vez, vale o arquivo mais recente.

### Como o app lê cada linha do relatório

Cada linha do relatório é um procedimento de um paciente num dia. O app agrupa as linhas por **paciente + dia** (um "atendimento") e marca cada procedimento pelo nome:

| Marca | Procedimentos que recebem a marca |
|---|---|
| 1ª consulta | "Primeira consulta odontológica programática" |
| Conclusão | "Tratamento concluído" |
| Urgência | qualquer descrição com "Atendimento de urgência" |
| Registro, não procedimento | 1ª consulta, tratamento concluído, "Atendimento odontológico", "Atendimento", urgência, consulta de nível superior, visita domiciliar, apoio matricial |
| Ignorado | "Evolução da atividade em grupo" e "Atividade educativa / orientação em grupo" (não são atendimentos individuais) |

Os nomes dos procedimentos são padronizados pelo catálogo do app, que é o mesmo da página Procedimentos. Por exemplo, as várias grafias de restauração viram um nome só.

### Variáveis

| Variável | Tipo | Como é calculada a partir do bruto | Coluna no CSV exportado |
|---|---|---|---|
| Sexo | Categoria | Coluna `Sexo` (o último valor preenchido do paciente no período) | `sexo` |
| Faixa etária | Ordem | `Idade` do **primeiro atendimento do período**, agrupada em 0–11, 12–17, 18–39, 40–59 e 60+. Idade em meses ou dias conta como 0 | `faixa_etaria` |
| Dentista principal | Categoria | Coluna `Profissional`: quem aparece em mais registros desse paciente no período, contando cada procedimento de cada dia uma vez (no empate, a ordem alfabética) | `dentista` |
| Atendido por mais de um dentista | Sim/Não | Sim se aparecem 2 ou mais nomes em `Profissional` | `mais_de_um_dentista` |
| Mês de entrada | Ordem | Mês da primeira `Data` do paciente no período | `mes_entrada` |
| Quadrimestre de entrada | Ordem | Quadrimestre (Q1 jan–abr, Q2 mai–ago, Q3 set–dez) da primeira `Data` | `quadrimestre_entrada` |
| Teve primeira consulta | Sim/Não | Sim se tem "Primeira consulta odontológica programática" no período | `primeira_consulta` |
| Concluiu tratamento | Sim/Não · **só quem teve 1ª consulta** | Sim se tem "Tratamento concluído" **no mesmo dia ou depois** da 1ª consulta | `concluiu` |
| Concluiu no mesmo dia da 1ª consulta | Sim/Não · **só quem concluiu** | Sim se a data da 1ª conclusão é igual à data da 1ª consulta | `concluiu_mesmo_dia` |
| Voltou mais de uma vez | Sim/Não | Sim se tem 2 ou mais **dias diferentes** de atendimento no período | `voltou` |
| Teve urgência | Sim/Não | Sim se algum procedimento tem "Atendimento de urgência" | `urgencia` |
| Teve preventivo | Sim/Não | Sim se fez algum procedimento que começa com Orientação, Profilaxia, Aplicação tópica, Aplicação de selante, Aplicação de cariostático ou Evidenciação | `preventivo` |
| Teve restauração | Sim/Não | Sim se fez Restauração ou Tratamento restaurador (inclui ART) | `restauracao` |
| Teve exodontia | Sim/Não | Sim se fez algum procedimento que começa com Exodontia | `exodontia` |
| Teve periodontia | Sim/Não | Sim se fez Raspagem, Gengivectomia, Tratamento de gengivite ou de pericoronarite | `periodontia` |
| Teve ART | Sim/Não | Sim se fez "Tratamento restaurador atraumático" | `art` |
| Voltou no quadrimestre seguinte | Sim/Não · **só quem entrou num quadrimestre cujo seguinte já foi importado** | Toma o quadrimestre de entrada; se há dados do quadrimestre seguinte dentro do período, é Sim quando o paciente tem atendimento nele. Quem entrou no Q3 fica vazio. Use o período **Ano** | `voltou_quadrimestre_seguinte` |
| Idade (anos) | Número | Mesma idade da faixa etária, em anos | `idade` |
| Dias de atendimento | Número | Quantidade de datas diferentes no período | `dias_atendimento` |
| Número de procedimentos | Número | Soma da coluna `Quantidade` dos procedimentos que **não** são registro (1ª consulta, conclusão, atendimento e urgência ficam fora) | `n_procedimentos` |
| Dias da 1ª consulta à conclusão | Número · **só quem concluiu** | Dias entre a data da 1ª consulta e a da 1ª conclusão (0 = mesmo dia) | `dias_ate_conclusao` |
| Número de dentistas | Número | Quantidade de nomes diferentes em `Profissional` | `n_dentistas` |
| Teve o procedimento… | Sim/Não | Você escolhe um procedimento da lista (nomes padronizados de tudo o que não é registro). É Sim se o paciente fez esse procedimento no período | `teve_<procedimento>` (só aparece no CSV quando está em uso) |

**Exemplo.** Um paciente com três linhas em 04/05: "Primeira consulta", "Profilaxia" e "Tratamento concluído". Fica com Teve primeira consulta = Sim, Concluiu = Sim, Concluiu no mesmo dia = Sim, Dias até conclusão = 0, Teve preventivo = Sim, Número de procedimentos = 1 e Voltou = Não.

---

## 2. Gestantes (Monitora APS)

**Relatório:** Monitora APS · *Listas de Pacientes Gestante e Puérpera*.
**Colunas brutas usadas:** `Equipe`, `Usuária` (só para juntar arquivos; não vai para a análise), `Período` e as 9 colunas de indicador.
**Quem entra:** todas as usuárias de todos os arquivos importados, **inclusive puérperas** e "Sem PN aberto". Os arquivos se somam: quando a mesma Usuária aparece em mais de um, vale o arquivo mais recente. O Monitora não traz data, então o filtro de período **não se aplica** a esta base.

| Variável | Tipo | Coluna bruta | Coluna no CSV exportado |
|---|---|---|---|
| Equipe | Categoria | `Equipe` (por exemplo 120, 121) | `equipe` |
| Período da gestação | Ordem (T1, T2, T3, Puerpério, Sem PN aberto) | `Período` | `periodo_gestacao` |
| 1ª consulta até 12 semanas | Sim/Não | `1ªCons.12s.` | `captacao_12s` |
| 7 consultas de pré-natal | Sim/Não | `7 consultas` | `sete_consultas` |
| 7 aferições de pressão | Sim/Não | `7 PA` | `sete_pa` |
| 7 registros de peso e altura | Sim/Não | `7 PesoAlt` | `sete_peso_altura` |
| Vacina DTPA | Sim/Não | `DTPA` | `dtpa` |
| Exames do 1º trimestre | Sim/Não | `Exames T1` | `exames_t1` |
| Exames do 3º trimestre | Sim/Não | `Exames T3` | `exames_t3` |
| Consulta de puerpério | Sim/Não | `Cons.Puérp.` | `consulta_puerperio` |
| Consulta odontológica | Sim/Não | `Cons.Odonto` | `consulta_odonto` |

As colunas Sim/Não vêm "Sim" ou "Não" no arquivo e entram exatamente assim. Qualquer outro valor fica vazio.

No teste de **tendência**, "Período da gestação" usa só T1, T2 e T3. Puerpério e "Sem PN aberto" ficam fora da ordem, e o app avisa quantas usuárias saíram.

---

## 3. Crianças das escovações

**Relatório:** CELK · *Relação das Atividades em Grupo* (CSV).
**Colunas brutas usadas:** `Data`, `Assunto`, `Temas`, `Local Atividade`, `Turno`, `Data de Nascimento`, `Sexo` e `Avaliação Alterada`. O nome do participante não entra.
**Quem entra:** cada participante de cada atividade de **escovação supervisionada** nos meses do período. Uma atividade conta como escovação quando o `Assunto` é "Escovação Supervisionada…" ou os `Temas` falam em escovação. É **uma linha por participação**: a mesma criança em duas escovações aparece duas vezes.

| Variável | Tipo | Como é calculada | Coluna no CSV exportado |
|---|---|---|---|
| Sexo | Categoria | `Sexo` (F → Feminino, M → Masculino) | `sexo` |
| Idade | Ordem ("9 anos", "10 anos"…) | Idade exata **na data da atividade**, calculada de `Data de Nascimento` | `idade_faixa` |
| Turma | Categoria | `Assunto` sem o começo "Escovação Supervisionada - " (por exemplo "Turma 48") | `turma` |
| Local | Categoria | `Local Atividade` | `local` |
| Turno | Categoria | `Turno` | `turno` |
| Avaliação alterada | Sim/Não | `Avaliação Alterada` | `avaliacao_alterada` |
| Idade (anos) | Número | Mesma idade, como número | `idade` |

Esta base **conta todas as crianças**, inclusive as que estão fora da faixa de M3/B4. O app avisa quantas estão fora da faixa de 6 a 11 anos, que vale até a véspera de completar 12 anos no dia da escovação.

---

## 4. Crianças do PSE

**Relatórios:** o CSV exportado da ferramenta de avaliação do PSE. Para os cruzamentos, também entram a *Relação das Atividades em Grupo* e o *Procedimentos Detalhado* do CELK.
**Colunas brutas do PSE usadas:** `Escola`, `Ano`, `Turma`, `Nascimento`, `CPF`, `Status Bucal`, `Lesões cariosas cavitadas`, `Necessidade de exodontia`, `Risco`, `PcD`, `Problemas periodontais`, `Presença de dor`, `Indicação ART (Bucal)`, `Encaminhado à UBS (Bucal)`, `Aplicação Tópica de Flúor realizada`, `Dentes a fazer (ART)`, `Dentes feitos (ART)`, `Status ART`, `Editado por (Bucal)` e `Editado por (ART)`.
**Quem entra:** cada avaliação cuja data fica dentro dos meses do período. A **data da avaliação** sai do texto "Editado por … em dd/mm/aaaa" (primeiro o da parte bucal; se estiver vazio, o do ART). Fica de fora quem está **pendente (ou vazio) no Status Bucal e no Status ART ao mesmo tempo**. Em todas as tabelas do arquivo, "—" é tratado como vazio.

"Avaliada" quer dizer `Status Bucal` = "Preenchida". Variáveis clínicas ficam vazias para quem não foi avaliado (ausente, recusou, pendente), para não contar falta como "Não".

| Variável | Tipo | Como é calculada | Coluna no CSV exportado |
|---|---|---|---|
| Sexo (da atividade coletiva) | Categoria · **só quem está ligado à atividade coletiva** | O PSE não traz sexo; vem da coluna `Sexo` da Relação das Atividades em Grupo quando a criança está ligada, ou do sexo que você preencher em "Dados cadastrais" | `sexo` |
| Escola | Categoria | `Escola` | `escola` |
| Turma | Categoria | `Turma` (por exemplo "401 · Matutino") | `turma` |
| Ano escolar | Categoria | `Ano` (por exemplo "Grupo 5/6", "4", "5") | `ano_escolar` |
| Meu aluno | Sim/Não | Sim se você marcou a criança em "Meus alunos" na página PSE | `meu_aluno` |
| Status da avaliação | Categoria | `Status Bucal` (Preenchida, Ausente, Recusou, Pendente) | `status` |
| Risco | Ordem (Baixo, Médio, Alto) · **só avaliadas** | `Risco` | `risco` |
| Risco alto | Sim/Não · **só avaliadas** | Sim se `Risco` = Alto | `risco_alto` |
| Lesões cariosas cavitadas | Ordem (Zero, 1 a 2 dentes, 3 a 4 dentes, 5 ou mais dentes) · **só avaliadas** | `Lesões cariosas cavitadas` | `lesoes_cavitadas` |
| Tem lesão cavitada | Sim/Não · **só avaliadas** | Sim se a coluna acima for diferente de "Zero" | `tem_lesao` |
| Necessidade de exodontia | Ordem (Não necessita, 1 dente, 2 ou mais dentes) · **só avaliadas** | `Necessidade de exodontia` | `necessidade_exodontia` |
| Precisa de exodontia | Sim/Não · **só avaliadas** | Sim se a coluna acima for diferente de "Não necessita" | `precisa_exodontia` |
| Dor | Sim/Não · **só avaliadas** | `Presença de dor` | `dor` |
| Problemas periodontais | Sim/Não · **só avaliadas** | `Problemas periodontais` | `periodontal` |
| PcD | Sim/Não | `PcD` (vale para todas as crianças) | `pcd` |
| Indicação de ART | Sim/Não · **só avaliadas** | `Indicação ART (Bucal)` | `indicacao_art` |
| Encaminhada à UBS | Sim/Não · **só avaliadas** | `Encaminhado à UBS (Bucal)` | `encaminhada` |
| Flúor aplicado | Sim/Não · **só avaliadas** | `Aplicação Tópica de Flúor realizada` | `fluor` |
| Já era paciente antes da avaliação | Sim/Não · **só quem tem prontuário ligado** | Sim se o prontuário ligado tem algum atendimento na produção **antes** da data da avaliação | `paciente_antes` |
| Atendida na UBS depois da avaliação | Sim/Não · **só quem tem prontuário ligado** | Sim se o prontuário tem algum atendimento **na data da avaliação ou depois**. **Não conta** o dia que só tem orientação de higiene bucal + aplicação tópica de flúor (com ou sem "atendimento odontológico" ou "urgência"), que é o lançamento do flúor feito na escola | `atendida_depois` |
| Avaliação alterada na escovação | Sim/Não · **só quem está ligado à atividade coletiva** | Sim se alguma escovação dessa criança no CELK teve `Avaliação Alterada` = Sim | `alterada_escovacao` |
| Idade (anos) | Número | Idade exata na data da avaliação, calculada pelo `Nascimento` (ou pelo nascimento corrigido em "Dados cadastrais") | `idade` |
| Dentes para ART | Número | Quantos números de dente há em `Dentes a fazer (ART)` (por exemplo "26, 55, 65" = 3) | `dentes_art` |
| Dentes de ART feitos | Número | Quantos números de dente há em `Dentes feitos (ART)` | `dentes_art_feitos` |
| Dias até o 1º atendimento na UBS | Número · **só quem foi atendida depois** | Dias entre a data da avaliação e o 1º atendimento que conta (mesma regra do flúor acima) | `dias_ate_atendimento` |
| Registros de contato | Número · **só meus alunos** | Quantos registros você fez na gaveta depois da avaliação (WhatsApp, bilhete, busca ativa, agendamento, atendida). Notas não contam | `contatos` |
| Cruzamento com o CELK | Categoria (Confirmado, A definir, Sem registro) | Situação do vínculo da criança com o CELK (regras abaixo) | `cruzamento` |

### Como a criança do PSE é ligada ao CELK

O vínculo só é feito sozinho quando o dado é **exatamente igual**. Diferença de acento, maiúscula e espaço não conta.

| Ligação | Liga sozinho quando | Fica "A definir" quando |
|---|---|---|
| PSE ↔ atividade coletiva (Relação das Atividades em Grupo) | `CPF` igual, **ou** nome e data de nascimento iguais | mesmo nome com nascimento diferente, ou mesmo nascimento com nome parecido |
| PSE ↔ produção (Procedimentos Detalhado) | nome igual **e** a `Idade` do relatório no dia do atendimento é igual à idade calculada pelo nascimento do PSE | a idade não confere, mais de um prontuário com o mesmo nome, ou o relatório não traz idade |

O que fica "A definir" só é ligado quando você confirma na aba "Vínculos a definir". Se você digitar o prontuário em "Dados cadastrais", ele passa a valer no lugar do cruzamento automático.

---

## O arquivo "Baixar dados para análise"

- O **CSV** tem uma coluna `id` e uma coluna para cada variável da base, com os nomes da coluna "CSV exportado" das tabelas acima. Ele segue o período e o subgrupo da tela. Vem separado por ";" e em UTF-8.
- O **script R** traz o dicionário dessas colunas e o código que refaz o teste da tela: `chisq.test`/`fisher.test`, `prop.test`, `prop.trend.test`, `wilcox.test`/`kruskal.test`, `cor.test` ou `glm(..., family = binomial)`.
- Por padrão, os nomes dos dentistas viram "Dentista A, B, C…".

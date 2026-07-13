# Configurando o Google Sheets Sync

O `npm run sync` (`src/index.js`) escreve os posts do dia anterior numa planilha Google
via `src/sheets.js`, usando uma **Service Account** do Google Cloud (não sua conta pessoal).

## 1. Criar o projeto e ativar a API

1. Acesse [console.cloud.google.com](https://console.cloud.google.com/) e crie um projeto
   (ou use um existente).
2. No menu, vá em **APIs e Serviços > Biblioteca**, busque por **Google Sheets API** e
   clique em **Ativar**.

## 2. Criar a Service Account

1. Vá em **APIs e Serviços > Credenciais > Criar Credenciais > Conta de serviço**.
2. Dê um nome (ex: `insta-dash-sync`) e conclua a criação — não precisa atribuir papéis
   de projeto (permissão é dada direto na planilha, no passo 4).
3. Na lista de contas de serviço, clique na que você criou > aba **Chaves** >
   **Adicionar Chave > Criar nova chave > JSON**. Um arquivo `.json` será baixado.

## 3. Extrair as credenciais do JSON baixado

Abra o arquivo baixado — ele tem este formato:

```json
{
  "client_email": "insta-dash-sync@seu-projeto.iam.gserviceaccount.com",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----\n",
  ...
}
```

- `client_email` → vai em `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `private_key` → vai em `GOOGLE_PRIVATE_KEY`, **exatamente como está no JSON**, incluindo
  os `\n` literais e as aspas ao redor (o código já converte `\n` para quebra de linha real).

## 4. Compartilhar a planilha com a Service Account

1. Abra a planilha Google que vai receber os dados.
2. Clique em **Compartilhar** e cole o `client_email` da Service Account (passo 3) com
   permissão de **Editor**.
3. Sem esse compartilhamento, toda chamada da API retorna erro 403 `The caller does not
   have permission`.

## 5. Preencher o `.env`

```
GOOGLE_SHEET_ID=<id da planilha — está na URL: docs.google.com/spreadsheets/d/AQUI/edit>
GOOGLE_SHEET_TAB=Posts
GOOGLE_SERVICE_ACCOUNT_EMAIL=insta-dash-sync@seu-projeto.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----\n"
```

No Render, essas mesmas variáveis já estão declaradas em `render.yaml` (com `sync: false`)
— preencha os valores reais direto no painel do Render, não no arquivo.

## 6. Testar

```
npm run sync
```

Isso busca os posts publicados ontem em cada conta configurada em `IG_ACCOUNTS` e
grava/atualiza uma linha por post na aba definida em `GOOGLE_SHEET_TAB`. Na primeira
execução, o cabeçalho é criado automaticamente na linha 1 se a aba estiver vazia.

Erros comuns:
- **403 permission denied** → a planilha não foi compartilhada com o `client_email` certo.
- **error:1E08010C:DECODER routines** → a `GOOGLE_PRIVATE_KEY` foi colada sem os `\n` ou
  sem as aspas ao redor do valor.

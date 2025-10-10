Baixar a última versão no repositório com o comando abaixo:

```shell
$ git clone https://github.com/trf2-jus-br/apoia.git
```

Substituir as propriedades de configuração do keycloak pelas abaixo:

```properties
# staging
KEYCLOAK_ISSUER=https://sso.stg.cloud.pje.jus.br/auth/realms/pje
KEYCLOAK_CREDENTIALS_SECRET=***PERGUNTE_ISSO_PARA_O_TRF2***
```

Incluir alguma chave de API como por exemplo:

```properties
GOOGLE_API_KEY=***OBTENHA_UMA_CHAVE_DE_API_DO_GOOGLE***
```

Introduzir a API do Data Lake

```properties
# staging
DATALAKE_API_URL=https://api-processo.stg.data-lake.pdpj.jus.br/processo-api/api/v1
```


Instalar as dependências com o comando abaixo:

```shell
$ npm install
```

Executar com o comando abaixo:

```shell
$ npm run dev
```

Caso queira "enganar" o sistema e conectar com o data lake de produção

```properties
#production
DATALAKE_API_URL=https://api-processo.data-lake.pdpj.jus.br/processo-api/api/v1
DATALAKE_TOKEN=***ESTE_ACCESS_TOKEN_DEVE_SER_OBTIDO_INSPECIONANDO_O_SITE_DA_APOIA_DE_PRODUÇÃO_NO_RECURSO_SESSION_NA_ABA_NETWORK***
```
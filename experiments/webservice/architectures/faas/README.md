The code will be built to this structure:

```
<function-name>
├── index.js
├── handler.js // business logic implementation from experiments/webservice/functions
├── auth // use case folder from experiments/webservice/authentication
│   ├── index.js // authentication logic
│   └── ... // other auth related files
└── package.json // dependencies and scripts
```
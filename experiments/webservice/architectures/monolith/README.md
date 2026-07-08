The code will be built to this structure:

```
<service-name>
├── index.js
├── functions // business logic implementations from experiments/webservice/functions
│   ├── <function>
│   │   └── index.js
│   └── ... // other functions
├── auth // use case folder from experiments/webservice/authentication
│   ├── index.js // authentication logic
│   └── ... // other auth related files
└── package.json // dependencies and scripts
```
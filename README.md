# BeFaaS Multi-Architecture and Authentication Benchmark

BeFaaS is an extensible open-source benchmarking framework for FaaS environments. It includes an e-commerce application (web shop) and an IoT application (smart traffic light), together with their load profiles. The original framework supports federated benchmarks in which functions can be distributed across six FaaS providers:

- AWS Lambda
- Google Cloud Functions
- Azure Functions
- TinyFaaS
- OpenFaaS
- OpenWhisk

## About This Fork

This fork extends the web-service benchmark so that the same application and workload can be evaluated across two experimental dimensions:

- **Deployment architecture:** AWS Lambda-based FaaS, an ECS/Fargate microservice application, or an ECS/Fargate monolith.
- **Authentication placement:** no authentication, service-integrated authentication, manually implemented service authentication, authentication at the edge, or selective authentication at the edge. The manual implementation can compare bcrypt/HS256 with Argon2id/EdDSA, and service-based deployments can verify tokens per function or once per service boundary.

It adds the corresponding application variants and AWS infrastructure, Cognito and Lambda@Edge/CloudFront support, ECS scaling policies, authentication-aware Artillery workloads, and an experiment runner that builds and deploys the system, executes the workload, collects logs, infrastructure metrics and pricing data, analyzes the results, tears down the deployment, and uploads the result bundle to S3. A PostgreSQL importer turns those result bundles into a common relational schema for cross-run analysis.

The fork is needed because the original FaaS-focused implementation assumes that functions are the deployment and isolation boundary. That is suitable for comparing FaaS providers, but it cannot isolate the effects of architecture and authentication placement. Supporting monoliths and microservices requires different packaging, routing, scaling, observability, and infrastructure, while edge and service authentication require consistent identity handling and instrumentation throughout the workload.

## Running an Experiment

The experiment runner provisions real cloud resources and may incur AWS charges. Use a dedicated AWS account where possible and verify that teardown succeeded. Infrastructure is destroyed after a run by default; `--keep-infra` disables that behavior.

### Prerequisites

- Node.js 16 or newer and npm
- Terraform, the AWS CLI, and AWS credentials with permission to create the benchmark resources
- Docker, including a running Docker daemon, for container builds and the analysis step
- An existing S3 bucket for result uploads (optional; a failed upload does not remove local results)

From the repository root, install the JavaScript dependencies and build the framework and analysis images:

```sh
npm ci
./docker/build.sh
./docker/build-analysis.sh
```

Configure the AWS CLI, then create and load an environment file. At minimum, set `AWS_REGION`. Set `BEFAAS_RESULTS_BUCKET` and `BEFAAS_RESULTS_REGION` to select the destination for result uploads; if omitted, the runner uses `befaas-benchmark-results` in `AWS_REGION`.

```sh
cp scripts/.env.example scripts/.env
# Edit scripts/.env, then export its values into the current shell:
set -a
. scripts/.env
set +a
aws sts get-caller-identity
```

Run the default web-service workload by selecting an architecture and authentication strategy:

```sh
# FaaS without authentication (512 MB Lambda functions)
node scripts/experiment.js --architecture faas --auth none --memory 512

# ECS monolith with service-integrated authentication
node scripts/experiment.js --architecture monolith --auth service-integrated \
  --cpu 512 --memory-fargate 1024

# ECS microservices with manual Argon2id/EdDSA authentication
node scripts/experiment.js --architecture microservices \
  --auth service-integrated-manual --algorithm argon2id-eddsa \
  --cpu 1024 --memory-fargate 2048

# Authentication at CloudFront/Lambda@Edge
node scripts/experiment.js --architecture faas --auth edge
```

Valid architectures are `faas`, `microservices`, and `monolith`. Valid authentication strategies are `none`, `service-integrated`, `service-integrated-manual`, `edge`, and `edge-selective`. Results are written to `results/<experiment>/<run-id>/`. Use a custom workload or output location with `--workload <file>` and `--output-dir <directory>`.

See every option, including ECS scaling controls and infrastructure reuse, without deploying anything:

```sh
node scripts/experiment.js --help
```

## Importing Results into PostgreSQL

The database importer is implemented as the `scripts/db_import` Python package (there is no standalone `db_import.py` file). It supports PostgreSQL and reads the standard libpq environment variables `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD`.

Create a virtual environment and install its dependencies:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r scripts/db_import/requirements.txt
```

Start or select a PostgreSQL database, then export its connection settings. You can edit and source `scripts/.env` as above, or set them directly:

```sh
export PGHOST=localhost
export PGPORT=5432
export PGDATABASE=befaas
export PGUSER=postgres
export PGPASSWORD='<password>'
```

Initialize the schema and import either one run or all run directories below a results directory:

```sh
python -m scripts.db_import init
python -m scripts.db_import import results/webservice/<run-id>
python -m scripts.db_import import-all results/webservice
```

Inspect the imported data with:

```sh
python -m scripts.db_import list
python -m scripts.db_import stats
python -m scripts.db_import --help
```

Use `init --drop` only when the existing benchmark tables may be deleted. Add `--force` to `import` or `import-all` to replace an experiment that was already imported.

## Usage and Further Information (for Developers)

- [Initial provider setup](doc/providerSetup.md)
- [(Re-) run paper experiments](doc/experiments.md)
- [Misc further information (TinyFaaS setup, debugging commands)](doc/misc.md)
- [Detailed setup and configuration (adv.)](doc/details.md)
- [Add/Adjust functions or applications (adv.)](doc/functions.md)
- [Add/Adjust providers (adv.)](doc/providers.md)

## Research Paper

[BeFaaS: An Application-Centric Benchmarking Framework for FaaS Environments](https://www.google.com/search?q=BeFaaS%3A+An+Application-Centric+Benchmarking+Framework+for+FaaS+Environments).

If you use this software in a publication, please cite it as:

### Text

Martin Grambow, Tobias Pfandzelter, Luk Burchard, Carsten Schubert, Max Zhao, David Bermbach. **BeFaaS: An Application-Centric Benchmarking Framework for FaaS Environments**. In: Proceedings of the 9th IEEE International Conference on Cloud Engineering (IC2E 2021), 2021.

### BibTeX

```TeX
@inproceedings{paper_grambow_befaas,
	title = "{BeFaaS}: An Application-Centric Benchmarking Framework for FaaS Environments",
	booktitle = "Proceedings of the 9th IEEE International Conference on Cloud Engineering (IC2E 2021)",
	author = Grambow, Martin and Pfandzelter, Tobias and Burchard, Luk and Schubert, Carsten and Zhao, Max and Bermbach, David",
	publisher = "IEEE"
	year = 2021
}
```

A full list of our [publications](https://www.tu.berlin/en/mcc/research/publications/) and [prototypes](https://www.tu.berlin/en/mcc/research/projects/) is available on our group website.

## Acknowledgment

We would like to thank Luk Burchard, Emily Dietrich, Carsten Schubert, Christoph Witzko, and Max Zhao who contributed to the implementation of our initial proof-of-concept prototype within the scope of a master’s [project](https://github.com/FaaSterMetrics) at TU Berlin.

## License

The code in this repository is licensed under the terms of the [Apache 2.0](./LICENSE) license.

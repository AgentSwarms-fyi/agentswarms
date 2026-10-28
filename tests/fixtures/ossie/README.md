# Apache Ossie fixtures

Unmodified copies of files from [apache/ossie](https://github.com/apache/ossie) at commit
`89e2e17f8249e68f30df7b29ac8852fa9dd24501` (2026-10-27), the Ossie 0.2.0.dev0 specification.
They are licensed under the Apache License 2.0 (the YAML files carry the ASF header; the JSON
Schemas cannot hold comments).

| File                          | Upstream path                          |
| ----------------------------- | -------------------------------------- |
| `ossie-schema.json`           | `core-spec/ossie-schema.json`          |
| `ontology.json`               | `ontology/ontology.json`               |
| `mapping.json`                | `ontology/mapping.json`                |
| `tpcds_semantic_model.yaml`   | `examples/tpcds_semantic_model.yaml`   |
| `flights.semantic_model.yaml` | `examples/flights.semantic_model.yaml` |
| `flights.ontology.yaml`       | `examples/flights.ontology.yaml`       |
| `flights.mapping.yaml`        | `examples/flights.mapping.yaml`        |

`tests/unit/ontologyOssie.test.ts` reads them: the schemas to check that the zod mirrors in
`src/lib/ontology/ossieSchema.ts` still match, the examples to check that they import. Update
them together, from one upstream commit, and change the commit above when you do.

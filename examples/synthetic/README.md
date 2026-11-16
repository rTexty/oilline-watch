# Synthetic inspection example

Generate a complete example from the repository root after installing `submission/requirements.txt`.

```sh
python -m examples.synthetic.generate .demo
```

| Route | History available | Forecast |
| --- | --- | --- |
| `900000001` | Two synthetic in-line inspections | 42 segments, repeat-inspection model |
| `900000002` | Synthetic route profile and operating history | 54 segments, first-inspection model |

Both forecasts use 1 January 2025 as the forecast date. Each segment is 10 m long. The generator creates all four source tables in `.demo/inputs/` without downloading anything. It produces an identical dataset on repeat runs and refuses to overwrite an input file with different contents.

Open the thickness view at `/degradation.html` and load `.demo/forecast/result.csv`. The same output directory contains `priority.csv`, a historical metrics report, and the run manifest. Priority ranks identify the segments with the lowest predicted remaining wall thickness. The reports show how the software behaves on invented values. Field validation requires independent inspection data.

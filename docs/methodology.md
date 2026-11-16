# How the forecast works

The output is an estimate of the **minimum remaining wall thickness** in each 10 m segment on an inspection date. An integrity team can use it to prepare a shortlist for field verification. The shortlist sorts segments by predicted thickness within each route and retains the lowest 10%, rounded up. It uses segment order to break ties. Operational criticality, consequences of failure and other integrity criteria must be assessed separately.

## Forecast paths

| Available evidence | Calculation |
| --- | --- |
| Previous in-line inspection | The baseline carries forward the minimum in each segment and subtracts a fixed annual allowance. The `shift_report_gap` option pools nearby shift scenarios to handle uncertain longitudinal alignment. It also uses prior reporting coverage and earlier completed transitions when available. |
| No prior in-line inspection | The first-inspection heuristic starts at the nominal wall thickness. It uses the height profile and historical wet, slow flow as indicators of possible liquid retention. The resulting thickness depends on the input coverage and the parameters of the heuristic. |

The Python pipeline writes the forecast, ranked segments, verification metrics and a manifest. The manifest records the model, forecast dates and source file hashes. The pipeline also supports a separate historical scoring run.

## Evaluation

Use a historical inspection as the prediction date and build the model inputs from earlier records. Score against the held-out segment minima. To test transfer to a route with no inspection history, hold out its direction from fitting and use only eligible earlier first inspections from other directions.

Report absolute error in millimetres and Pearson correlation on measured segments. Keep the signed correlation beside its square so a reversal of the thickness ordering stays visible. When ranking inspections, measure recall at the planned inspection budget. Show the effect of filling unmeasured segments with nominal thickness as a separate sensitivity analysis.

## Browser pressure lab

The lab models short pressure transients on a synthetic line. It computes locally in browser workers and renders the pipe with WebGL or a 2D fallback. A user chooses an event coordinate, compares the simulated measurements to a nominal pressure trajectory, then reveals the event. The revealed coordinate comes from the configured simulation. The displayed residuals are measurements minus that nominal trajectory.

The pressure lab runs independently of the wall-thickness pipeline. Field use of either module would require calibration and validation on representative inspection or telemetry data.

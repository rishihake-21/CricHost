# Fixtures and standings

Fixture generation is an owner/admin command available after registration closes. The first implementation supports round-robin tournaments only. It requires at least two active teams and every team must meet the configured minimum squad size. It shuffles teams with a saved seed, applies a circle round-robin pairing algorithm, records byes for odd team counts, and stores the algorithm version and team/roster snapshot for reproducibility.

The request supplies an RFC 3339 start time with an explicit offset, match duration and interval. Fixtures are scheduled sequentially, with no overlaps, and the full match duration must fit inside the tournament date window. Times are stored as UTC instants; the tournament timezone is used by display clients. Venue assignment is not available yet.

Fixture creation, initial zeroed standings rows, tournament transition to SCHEDULED, audit record and outbox event commit in one transaction. Match completion updates both teams' played/result/points rows transactionally; T10/T20/ODI results also update net run rate from completed innings. Points are configurable in tournament rules with 2/1/1 win/tie/no-result defaults. Schedule rescheduling, knockout brackets, group-knockout generation and points/NRR rules review remain future work.

HTTP contract: `docs/openapi/fixtures.yaml`.

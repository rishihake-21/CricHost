# Teams

Teams are tournament-scoped organization resources. Creating a team requires an organization owner or administrator; the creator becomes its team owner. Team owners can assign active organization members as managers or bidders. Team owners/managers can manage direct roster entries after registration closes and while the tournament is registration-closed or scheduled, before live play.

Teams and roster operations are tenant-scoped and write audit plus outbox records transactionally. Team aggregate versions advance on roster changes. Direct additions require an approved tournament application, the current team version, and available squad capacity. Reassigning a released player requires a reason. Release preserves the roster entry and adds history instead of deleting it. Direct roster changes lock once an auction is created because each purse starts from a frozen roster count.

HTTP contract: `docs/openapi/teams-rosters.yaml`. Auction-result writes, team owner transfer, removal of staff, and schedule-time roster changes are not implemented.

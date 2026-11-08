# Tournament roster rights

An active roster entry gives a player one team assignment within a tournament. MongoDB enforces one roster record per player and tournament, including released records; restoration updates that record and appends an assignment or transfer history event. Release is an explicit state change with an actor, reason, timestamp and expected roster version.

Direct assignments require an approved registration for the same tenant and tournament. The tournament must be registration-closed or scheduled, and the destination team must remain under the configured maximum squad size. Direct roster edits lock when an auction is created. Auction hammer settlement will later write the same roster aggregate with `AUCTION_RESULT` as the source.

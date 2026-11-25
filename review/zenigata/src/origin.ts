/**
 * The runtime's origin-record composition (ADR: "Session origin as a
 * create-time metadata signal"): the record a programmatic spawn stamps
 * under the `chancery_origin` metadata key. The shape and vocabulary are
 * the ADR's record — initiator "program" for the tooling's own spawns,
 * parent naming the creating session, or null when the creating side is
 * not itself a session. The memory client parses this shape at its one
 * mapping point, and the origin contract test ties the producers to the
 * consumer across the package boundary. This module deliberately imports
 * nothing: the contract test reads it with node's type-stripped runner
 * from another package's tree, where no dependency is resolvable.
 */

export function originRecord(parent: string | null): {
  initiator: "program";
  parent: string | null;
} {
  return { initiator: "program", parent };
}

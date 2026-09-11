/**
 * How a rig is named everywhere in the UI.
 *
 * A rig has one identity — its Rig Name, the column Admin > Master > Rig
 * Master lists it under. Screens used to render `rigNumber - name` side by
 * side, which showed the same rig twice ("Rig 100-01 - Rig 100-01") and, when
 * the two had drifted, showed two different names for one rig
 * ("GTC 160-01 - RIG 160-01"). Everything goes through this instead.
 *
 * `rigNumber` is still the value the Excel workbooks and the rigKey bridge
 * match on underneath — it just isn't a second display name.
 */
export function rigLabel(rig: { name?: string | null; rigNumber?: string | null } | null | undefined): string {
  if (!rig) return '';
  return (rig.name ?? '').trim() || (rig.rigNumber ?? '').trim();
}

// Armor item data model.
// Equipped armor contributes damage reduction and armor check penalty to actors.
const fields = foundry.data.fields;

export class ConanArmorData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      description: new fields.HTMLField({ required: true, initial: "" }),
      category: new fields.StringField({ required: true, initial: "" }),
      damageReduction: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      armorPenalty: new fields.NumberField({ required: true, integer: true, initial: 0 }),
      equipped: new fields.BooleanField({ required: true, initial: true }),
      weight: new fields.NumberField({ required: true, initial: 0 }),
      cost: new fields.StringField({ required: true, initial: "" })
    };
  }
}

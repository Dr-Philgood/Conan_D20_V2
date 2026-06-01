import { CONAN } from "../config.mjs";
import { abilityMod, clampNumber } from "../helpers/utils.mjs";
import { createDefaultClassRow, getActorClassRows, getActorClassTotals, normalizeActorClasses } from "../data/common.mjs";
import { rollFormula } from "../dice/rolls.mjs";

// Permanent damage lookup table keyed by the final 2d6 + damage-over-threshold result.
const PERMANENT_DAMAGE_RESULTS = [
  { min: -Infinity, max: -1, key: "noEffect", label: "No Effect" },
  { min: 0, max: 0, key: "minorScar", label: "Minor Scar" },
  { min: 1, max: 3, key: "impressiveScar", label: "Impressive Scar" },
  { min: 4, max: 7, key: "painfulWound", label: "Painful Wound" },
  { min: 8, max: 10, key: "slowlyHealingWound", label: "Slowly Healing Wound" },
  { min: 11, max: 11, key: "hideousScar", label: "Hideous Scar" },
  { min: 12, max: 12, key: "limbDamaged", label: "Limb Damaged" },
  { min: 13, max: 13, key: "agonisingWound", label: "Agonising Wound" },
  { min: 14, max: 14, key: "sensoryOrganDamaged", label: "Sensory Organ Damaged" },
  { min: 15, max: 15, key: "organDamage", label: "Organ Damage" },
  { min: 16, max: 16, key: "excessiveBloodLoss", label: "Excessive Blood Loss" },
  { min: 17, max: 17, key: "limbMaimed", label: "Limb Maimed" },
  { min: 18, max: 18, key: "sensoryOrganMaimed", label: "Sensory Organ Maimed" },
  { min: 19, max: 19, key: "organRupture", label: "Organ Rupture" },
  { min: 20, max: Infinity, key: "headTrauma", label: "Head Trauma" }
];

function getIterativeBabBonuses(baseAttackBonus) {
  const bab = clampNumber(baseAttackBonus);
  const attackCount = Math.max(1, Math.min(4, Math.floor((bab - 1) / 5) + 1));
  return Array.from({ length: attackCount }, (_value, index) => bab - (index * 5));
}

function formatSignedBonus(value) {
  const bonus = clampNumber(value);
  return bonus >= 0 ? `+${bonus}` : `${bonus}`;
}

export class ConanActor extends Actor {
  prepareDerivedData() {
    super.prepareDerivedData();

    const system = this.system;

    // Normalize editable class rows before derived stats read from them.
    system.classes = normalizeActorClasses(system.classes, this.type);

    // Ability modifiers are derived from ability scores every prepare cycle.
    for (const ability of Object.values(system.abilities)) {
      ability.mod = abilityMod(ability.value);
    }

    // Massive damage is Constitution; permanent damage uses Constitution plus STR and DEX modifiers.
    system.combat.massiveDamage ??= { total: 0 };
    system.combat.massiveDamage.total = clampNumber(system.abilities.con.value);
    system.combat.threshold.total =
      clampNumber(system.abilities.con.value) +
      clampNumber(system.abilities.str.mod) +
      clampNumber(system.abilities.dex.mod);

    const injuryMods = this._getInjuryModifiers();
    const classTotals = this.getClassTotals();
    const hpRolled = system.classes.reduce((sum, row) => sum + clampNumber(row.hpRolled), 0);
    const hpLevel = Math.max(clampNumber(system.details.level), clampNumber(classTotals.level));
    const toughnessHp = Math.min(10, Math.max(0, clampNumber(system.combat.featToggles?.toughness?.ranks)));
    system.combat.hp.max = Math.max(0, hpRolled + (clampNumber(system.abilities.con.mod) * hpLevel) + toughnessHp);

    // Base save and attack values come from the class progression table.
    if (system.saves?.fort) system.saves.fort.base = clampNumber(classTotals.fort);
    if (system.saves?.ref) system.saves.ref.base = clampNumber(classTotals.ref);
    if (system.saves?.will) system.saves.will.base = clampNumber(classTotals.will);

    if (system.combat?.attack?.melee) {
      system.combat.attack.melee.base = clampNumber(classTotals.bab);
    }

    if (system.combat?.attack?.ranged) {
      system.combat.attack.ranged.base = clampNumber(classTotals.bab);
    }

    if (system.combat?.dodge) {
      system.combat.dodge.base = 10 + clampNumber(classTotals.dodge);
    }

    if (system.combat?.parry) {
      system.combat.parry.base = 10 + clampNumber(classTotals.parry);
    }

    if (system.combat?.magicAttack) {
      system.combat.magicAttack.base = clampNumber(classTotals.magicAttack);
      system.combat.magicAttack.total =
        clampNumber(system.combat.magicAttack.base) +
        clampNumber(system.combat.magicAttack.misc) +
        clampNumber(system.abilities.cha?.mod);
    }

    if (system.movement?.speed) {
      system.movement.speed.total = Math.max(
        0,
        clampNumber(system.movement.speed.base) +
        clampNumber(system.movement.speed.armor) +
        clampNumber(system.movement.speed.misc)
      );
    }

    // Total saving throws combine class base, misc bonus, ability modifier, and injuries.
    for (const [key, save] of Object.entries(system.saves)) {
      const abilityKey = save.ability || CONAN.saves[key]?.ability;
      const mod = system.abilities[abilityKey]?.mod ?? 0;
      const extraFort = key === "fort" ? injuryMods.fortitude : 0;
      save.total = clampNumber(save.base) + clampNumber(save.misc) + clampNumber(mod) + clampNumber(extraFort);
    }

    // Equipped armor contributes both damage reduction and armor check penalty.
    const equippedArmor = this.items.filter((item) => item.type === "armor" && item.system.equipped);

    const armorPenalty = equippedArmor.reduce((sum, item) => {
      const value = clampNumber(item.system.armorPenalty);
      return sum + (value > 0 ? -value : value);
    }, 0);

    const armorDr = equippedArmor.reduce(
      (sum, item) => sum + clampNumber(item.system.damageReduction),
      0
    );

    system.combat.armorCheckPenalty = armorPenalty;
    system.combat.damageReduction.armor = armorDr;
    system.combat.damageReduction.total =
      clampNumber(system.combat.damageReduction.armor) +
      clampNumber(system.combat.damageReduction.misc);

    if (system.movement?.encumbrance) {
      system.movement.encumbrance.current = this.items.reduce((sum, item) => {
        const quantity = item.type === "gear" ? clampNumber(item.system.quantity, 1) : 1;
        return sum + (clampNumber(item.system.weight) * quantity);
      }, 0);
    }

    // Final combat numbers shown on the overview tab.
    system.combat.dodge.total =
      clampNumber(system.combat.dodge.base) +
      clampNumber(system.combat.dodge.misc) +
      clampNumber(system.abilities.dex.mod) +
      clampNumber(injuryMods.dodge);

    system.combat.parry.total =
      clampNumber(system.combat.parry.base) +
      clampNumber(system.combat.parry.misc) +
      clampNumber(system.abilities.str.mod);

    system.combat.initiative.total =
      clampNumber(system.abilities.dex.mod) +
      clampNumber(system.combat.initiative.misc);

    system.combat.attack.melee.total =
      clampNumber(system.combat.attack.melee.base) +
      clampNumber(system.combat.attack.melee.misc) +
      clampNumber(system.abilities.str.mod) +
      clampNumber(injuryMods.allAttacks) +
      clampNumber(injuryMods.meleeAttack) -
      (system.combat.featToggles?.powerAttack?.active ? clampNumber(system.combat.featToggles.powerAttack.value) : 0);

    system.combat.attack.ranged.total =
      clampNumber(system.combat.attack.ranged.base) +
      clampNumber(system.combat.attack.ranged.misc) +
      clampNumber(system.abilities.dex.mod) +
      clampNumber(injuryMods.allAttacks) +
      clampNumber(injuryMods.rangedAttack) +
      (system.combat.featToggles?.pointBlankShot?.active ? 1 : 0) -
      (system.combat.featToggles?.rapidShot?.active ? 2 : 0);

    // Skill totals combine ranks, misc, ability, armor penalty, and injury modifiers.
    for (const [key, skill] of Object.entries(system.skills)) {
      const abilityKey = skill.keyAbility || CONAN.skills[key]?.ability;
      const abilityValue = system.abilities[abilityKey]?.mod ?? 0;
      const armorCheckPenalty = skill.armorCheck ? system.combat.armorCheckPenalty : 0;

      let extra = clampNumber(injuryMods.allSkills);

      if (key === "diplomacy") extra += clampNumber(injuryMods.diplomacy) + clampNumber(injuryMods.speech);
      if (key === "disguise") extra += clampNumber(injuryMods.disguise);
      if (key === "gatherInformation") extra += clampNumber(injuryMods.gatherInformation) + clampNumber(injuryMods.speech);
      if (key === "intimidate") extra += clampNumber(injuryMods.intimidate) + clampNumber(injuryMods.speech);
      if (key === "acrobatics") extra += clampNumber(injuryMods.balance);
      if (key === "perception") extra += clampNumber(injuryMods.listen) + clampNumber(injuryMods.spot);
      if (key === "search") extra += clampNumber(injuryMods.search);
      if (key === "bluff" || key === "handleAnimal" || key === "challenge") extra += clampNumber(injuryMods.speech);

      skill.total =
        clampNumber(skill.ranks) +
        clampNumber(skill.misc) +
        clampNumber(abilityValue) +
        clampNumber(armorCheckPenalty) +
        extra;
    }

    this._prepareCustomSkills();
  }

  _prepareCustomSkills() {
    // Custom Profession/Craft/Perform rows follow the same total pattern as core skills.
    const groups = ["professions", "crafts", "performs"];
    const injuryMods = this._getInjuryModifiers();

    for (const group of groups) {
      const entries = this.system.customSkills?.[group] ?? [];
      for (const entry of entries) {
        const abilityModValue = this.system.abilities[entry.keyAbility]?.mod ?? 0;
        const armorCheckPenalty = entry.armorCheck ? this.system.combat.armorCheckPenalty : 0;
        let extra = 0;

        if (group === "performs") extra += clampNumber(injuryMods.perform) + clampNumber(injuryMods.speech);

        entry.total =
          clampNumber(entry.ranks) +
          clampNumber(entry.misc) +
          clampNumber(abilityModValue) +
          clampNumber(armorCheckPenalty) +
          extra;
      }
    }
  }

  _getInjuryModifiers() {
    // Collapse active injury penalty objects into one modifier set.
    const totals = {
      allAttacks: 0,
      allSkills: 0,
      meleeAttack: 0,
      meleeDamage: 0,
      rangedAttack: 0,
      dodge: 0,
      fortitude: 0,
      diplomacy: 0,
      disguise: 0,
      gatherInformation: 0,
      perform: 0,
      intimidate: 0,
      balance: 0,
      listen: 0,
      search: 0,
      spot: 0,
      speech: 0
    };

    for (const injury of this.system.injuries ?? []) {
      if (!injury.active) continue;
      for (const [key, value] of Object.entries(injury.penalties ?? {})) {
        totals[key] = clampNumber(totals[key]) + clampNumber(value);
      }
    }

    return totals;
  }

  getRollData() {
    // Add a clone of system data so formulas can safely reference actor stats.
    const data = super.getRollData();
    data.system = foundry.utils.deepClone(this.system);
    return data;
  }

  async rollAbility(abilityKey) {
    // Roll a basic d20 ability check.
    const ability = this.system.abilities[abilityKey];
    if (!ability) return null;

    const label = game.i18n.localize(CONAN.abilities[abilityKey].label);
    return rollFormula({
      actor: this,
      formula: `1d20 + ${ability.mod}`,
      flavor: `${label} Check`
    });
  }

  async rollSave(saveKey) {
    // Roll a d20 saving throw using the prepared total.
    const save = this.system.saves[saveKey];
    if (!save) return null;

    const label = game.i18n.localize(CONAN.saves[saveKey].label);
    return rollFormula({
      actor: this,
      formula: `1d20 + ${save.total}`,
      flavor: `${label} Save`
    });
  }

  async rollSkill(skillKey) {
    // Roll one of the built-in skills from the skills tab.
    const skill = this.system.skills[skillKey];
    if (!skill) return null;

    const label = CONAN.skills[skillKey]?.label ?? skillKey;
    return rollFormula({
      actor: this,
      formula: `1d20 + ${skill.total}`,
      flavor: `${label} Skill Check`
    });
  }

  async rollCustomSkill(group, skillId) {
    // Roll a user-created Profession, Craft, or Perform entry.
    const entry = (this.system.customSkills?.[group] ?? []).find((s) => s.id === skillId);
    if (!entry) return null;

    const groupLabel =
      group === "professions" ? "Profession" :
      group === "crafts" ? "Craft" :
      "Perform";

    const label = `${groupLabel} (${entry.name || "Unnamed"})`;

    return rollFormula({
      actor: this,
      formula: `1d20 + ${clampNumber(entry.total)}`,
      flavor: `${label} Skill Check`
    });
  }

  async addCustomSkill(group) {
    // Add a blank custom skill row with the default ability for its group.
    const path = `system.customSkills.${group}`;
    const entries = foundry.utils.deepClone(foundry.utils.getProperty(this, path) ?? []);
    entries.push({
      id: foundry.utils.randomID(),
      name: "",
      keyAbility: group === "professions" ? "wis" : group === "crafts" ? "int" : "cha",
      ranks: 0,
      misc: 0,
      armorCheck: false,
      trainedOnly: false,
      total: 0
    });
    return this.update({ [path]: entries });
  }

  async addSorceryEntry(group) {
    // Add one blank row to a sorcery list such as styles, spells, or rituals.
    const path = `system.sorcery.${group}`;
    const entries = foundry.utils.deepClone(foundry.utils.getProperty(this, path) ?? []);
    entries.push({
      id: foundry.utils.randomID(),
      name: "",
      style: "",
      source: "",
      ppCost: "",
      castingTime: "",
      range: "",
      duration: "",
      components: "",
      difficulty: "",
      prepared: false,
      notes: ""
    });
    return this.update({ [path]: entries });
  }

  async addTrackerEntry(path) {
    // Add a blank row to a generic actor tracker such as feats or languages.
    const entries = foundry.utils.deepClone(foundry.utils.getProperty(this, path) ?? []);
    entries.push({
      id: foundry.utils.randomID(),
      name: "",
      type: "",
      source: "",
      level: 0,
      bonus: "",
      active: true,
      notes: ""
    });
    return this.update({ [path]: entries });
  }

  async removeTrackerEntry(path, entryId) {
    // Remove one row from a generic actor tracker.
    const entries = foundry.utils.deepClone(foundry.utils.getProperty(this, path) ?? []);
    return this.update({ [path]: entries.filter((entry) => entry.id !== entryId) });
  }

  async removeSorceryEntry(group, entryId) {
    // Remove a sorcery row by its generated ID.
    const path = `system.sorcery.${group}`;
    const entries = foundry.utils.deepClone(foundry.utils.getProperty(this, path) ?? []);
    return this.update({ [path]: entries.filter((entry) => entry.id !== entryId) });
  }

  async removeCustomSkill(group, skillId) {
    // Remove a custom skill row by its generated ID.
    const path = `system.customSkills.${group}`;
    const entries = foundry.utils.deepClone(foundry.utils.getProperty(this, path) ?? []);
    const filtered = entries.filter((entry) => entry.id !== skillId);
    return this.update({ [path]: filtered });
  }

  async rollInitiativeCheck() {
    // Roll initiative as a normal d20 check with the prepared initiative total.
    return rollFormula({
      actor: this,
      formula: `1d20 + ${this.system.combat.initiative.total}`,
      flavor: game.i18n.localize("CONAN.Roll.Initiative")
    });
  }

  async rollMagicAttack() {
    // Roll a magic attack check from the sorcery tab.
    return rollFormula({
      actor: this,
      formula: `1d20 + ${this.system.combat.magicAttack.total}`,
      flavor: "Magic Attack"
    });
  }

  async spendPowerPoint() {
    const current = clampNumber(this.system.sorcery?.powerPoints?.value);
    return this.update({ "system.sorcery.powerPoints.value": Math.max(0, current - 1) });
  }

  async recoverPowerPoint() {
    const current = clampNumber(this.system.sorcery?.powerPoints?.value);
    const max = clampNumber(this.system.sorcery?.powerPoints?.max);
    return this.update({ "system.sorcery.powerPoints.value": Math.min(max, current + 1) });
  }

  async spendFatePoint() {
    const current = clampNumber(this.system.resources?.fate?.value);
    return this.update({ "system.resources.fate.value": Math.max(0, current - 1) });
  }

  async recoverFatePoint() {
    const current = clampNumber(this.system.resources?.fate?.value);
    return this.update({ "system.resources.fate.value": current + 1 });
  }

  async rollCorruptionCheck() {
    const modifier = clampNumber(this.system.sorcery?.corruption?.score);
    return rollFormula({
      actor: this,
      formula: `1d20 + ${modifier}`,
      flavor: "Corruption Check"
    });
  }

  getWeaponAttackSequence(itemId) {
    const item = this.items.get(itemId);
    if (!item || item.type !== "weapon") return [];

    const parts = this._getWeaponAttackParts(item);
    const baseAttacks = getIterativeBabBonuses(parts.baseBab);
    const attacks = parts.rapidShot ? [baseAttacks[0], ...baseAttacks] : baseAttacks;

    return attacks.map((bab, index) => {
      const total =
        bab +
        parts.misc +
        parts.abilityMod +
        parts.itemBonus +
        parts.injuryBonus +
        parts.featAttackBonus +
        parts.rapidShotPenalty;
      return {
        index,
        bab,
        total,
        label: formatSignedBonus(total),
        rapid: parts.rapidShot && index === 0
      };
    });
  }

  _getWeaponAttackParts(item) {
    const isRangedAttack = item.system.attackType === "ranged" || item.system.attackType === "thrown";
    const isMeleeAttack = item.system.attackType === "melee";
    const injuryMods = this._getInjuryModifiers();
    const featToggles = this.system.combat.featToggles ?? {};
    const powerAttackValue = featToggles.powerAttack?.active && isMeleeAttack
      ? clampNumber(featToggles.powerAttack.value)
      : 0;
    const pointBlankShotBonus = featToggles.pointBlankShot?.active && isRangedAttack ? 1 : 0;
    const rapidShotPenalty = featToggles.rapidShot?.active && isRangedAttack ? -2 : 0;

    const abilityModValue =
      item.system.finesse && item.system.attackType === "melee"
        ? clampNumber(this.system.abilities.dex.mod)
        : isRangedAttack
          ? clampNumber(this.system.abilities.dex.mod)
          : clampNumber(this.system.abilities.str.mod);

    const attackData = isRangedAttack
      ? this.system.combat.attack.ranged
      : this.system.combat.attack.melee;

    const injuryBonus =
      clampNumber(injuryMods.allAttacks) +
      (isRangedAttack ? clampNumber(injuryMods.rangedAttack) : clampNumber(injuryMods.meleeAttack));

    return {
      isRangedAttack,
      baseBab: clampNumber(attackData.base),
      misc: clampNumber(attackData.misc),
      abilityMod: abilityModValue,
      itemBonus: clampNumber(item.system.attackBonus),
      injuryBonus,
      featAttackBonus: pointBlankShotBonus - powerAttackValue,
      rapidShotPenalty,
      powerAttackValue,
      pointBlankShotBonus,
      rapidShot: featToggles.rapidShot?.active && isRangedAttack
    };
  }

  async rollWeaponAttack(itemId, attackIndex = 0, { fullAttack = false, showAttackNumber = false } = {}) {
    // Roll an embedded weapon attack using weapon type, finesse, and attack bonus.
    const item = this.items.get(itemId);
    if (!item || item.type !== "weapon") return null;

    const parts = this._getWeaponAttackParts(item);
    const attacks = getIterativeBabBonuses(parts.baseBab);
    const sequence = fullAttack && parts.rapidShot ? [attacks[0], ...attacks] : attacks;
    const selectedIndex = Math.max(0, Math.min(sequence.length - 1, clampNumber(attackIndex)));
    const iterativeBab = sequence[selectedIndex];
    const total =
      iterativeBab +
      parts.misc +
      parts.abilityMod +
      parts.itemBonus +
      parts.injuryBonus +
      parts.featAttackBonus +
      (fullAttack ? parts.rapidShotPenalty : 0);
    const attackLabel = showAttackNumber && sequence.length > 1 ? ` #${selectedIndex + 1}` : "";
    const featLabels = [];
    if (parts.powerAttackValue) featLabels.push(`Power Attack -${parts.powerAttackValue}`);
    if (parts.pointBlankShotBonus) featLabels.push("Point Blank Shot");
    if (fullAttack && parts.rapidShot) featLabels.push("Rapid Shot");
    const featText = featLabels.length ? `, ${featLabels.join(", ")}` : "";

    return rollFormula({
      actor: this,
      formula: `1d20 + ${total}`,
      flavor: `${item.name} Attack${attackLabel}${item.system.armorPiercing ? ` (AP ${item.system.armorPiercing})` : ""}${featText}`
    });
  }

  async rollWeaponFullAttack(itemId) {
    const sequence = this.getWeaponAttackSequence(itemId);
    for (const attack of sequence) {
      await this.rollWeaponAttack(itemId, attack.index, { fullAttack: true, showAttackNumber: true });
    }
  }

  async rollWeaponDamage(itemId) {
    // Roll weapon damage and add Strength based on melee/thrown handedness rules.
    const item = this.items.get(itemId);
    if (!item || item.type !== "weapon") return null;

    const strMod = clampNumber(this.system.abilities.str.mod);
    let bonus = 0;

    if (item.system.attackType === "melee") {
      if (item.system.handedness === "two") bonus = Math.floor(strMod * 1.5);
      else if (item.system.handedness === "off") bonus = Math.floor(strMod / 2);
      else bonus = strMod;
    } else if (item.system.attackType === "thrown") {
      bonus = strMod;
    }

    const featToggles = this.system.combat.featToggles ?? {};
    const isRangedAttack = item.system.attackType === "ranged" || item.system.attackType === "thrown";
    const powerAttackValue = featToggles.powerAttack?.active && item.system.attackType === "melee"
      ? clampNumber(featToggles.powerAttack.value)
      : 0;
    const powerAttackDamage = item.system.handedness === "two" ? powerAttackValue * 2 : powerAttackValue;
    const pointBlankShotDamage = featToggles.pointBlankShot?.active && isRangedAttack ? 1 : 0;
    const totalBonus = bonus + powerAttackDamage + pointBlankShotDamage;
    const formula = totalBonus ? `${item.system.damage} ${formatSignedBonus(totalBonus)}` : item.system.damage;
    const featLabels = [];
    if (powerAttackDamage) featLabels.push(`Power Attack +${powerAttackDamage}`);
    if (pointBlankShotDamage) featLabels.push("Point Blank Shot +1");
    const featText = featLabels.length ? `, ${featLabels.join(", ")}` : "";

    return rollFormula({
      actor: this,
      formula,
      flavor: `${item.name} Damage${item.system.damageType ? ` (${item.system.damageType})` : ""}${featText}`
    });
  }

  static getPermanentDamageResult(total) {
    // Resolve a permanent damage total to its table entry.
    return PERMANENT_DAMAGE_RESULTS.find((entry) => total >= entry.min && total <= entry.max);
  }

  static randomFromTable(size) {
    // Uniform 1-based table roll helper for injury locations.
    return Math.ceil(CONFIG.Dice.randomUniform() * size);
  }

  static createPermanentDamageEntry(resultKey, damage = 0) {
    // Build the injury record that may be stored on the actor after a damage check.
    const entry = {
      id: foundry.utils.randomID(),
      label: "",
      location: "",
      healDc: 0,
      bedRest: "",
      notes: "",
      active: true,
      slowlyHealingDamage: 0,
      penalties: {
        allAttacks: 0,
        allSkills: 0,
        meleeAttack: 0,
        meleeDamage: 0,
        rangedAttack: 0,
        dodge: 0,
        fortitude: 0,
        diplomacy: 0,
        disguise: 0,
        gatherInformation: 0,
        perform: 0,
        intimidate: 0,
        balance: 0,
        listen: 0,
        search: 0,
        spot: 0,
        speech: 0
      }
    };

    switch (resultKey) {
      case "noEffect":
        entry.label = "No Effect";
        entry.notes = "Superficial wound only.";
        entry.active = false;
        break;
      case "minorScar":
        entry.label = "Minor Scar";
        entry.notes = "Small permanent scar.";
        break;
      case "impressiveScar":
        entry.label = "Impressive Scar";
        entry.notes = "Visible scar; +1 circumstance bonus to Diplomacy, Gather Information, and Intimidate against combat-hardened characters.";
        break;
      case "painfulWound":
        entry.label = "Painful Wound";
        entry.healDc = 18;
        entry.bedRest = "Until treated";
        entry.notes = "Until treated, suffer -1 to all attack and skill rolls.";
        entry.penalties.allAttacks = -1;
        entry.penalties.allSkills = -1;
        break;
      case "slowlyHealingWound":
        entry.label = "Slowly Healing Wound";
        entry.slowlyHealingDamage = damage;
        entry.notes = `Record ${damage} damage separately; it heals at only 1 hit point per full night of rest.`;
        break;
      case "hideousScar":
        entry.label = "Hideous Scar";
        entry.notes = "If visible, -1 to Diplomacy, Disguise, Gather Information, and Perform.";
        entry.penalties.diplomacy = -1;
        entry.penalties.disguise = -1;
        entry.penalties.gatherInformation = -1;
        entry.penalties.perform = -1;
        break;
      case "limbDamaged": {
        const limbRoll = this.randomFromTable(6);
        const limbMap = { 1: "Left Hand", 2: "Right Hand", 3: "Left Arm", 4: "Right Arm", 5: "Left Leg", 6: "Right Leg" };
        entry.label = "Limb Damaged";
        entry.location = limbMap[limbRoll];
        entry.healDc = 20;
        entry.bedRest = "8 hours";
        if (limbRoll <= 2) entry.notes = `${entry.location}: -2 to any skill or attack roll using that hand.`;
        else if (limbRoll <= 4) {
          entry.notes = `${entry.location}: no shield on that arm; -2 to attack and damage rolls from melee weapons held by that arm.`;
          entry.penalties.meleeAttack = -2;
          entry.penalties.meleeDamage = -2;
        } else {
          entry.notes = `${entry.location}: -5 ft. Speed and -1 Dodge until treated.`;
          entry.penalties.dodge = -1;
        }
        break;
      }
      case "agonisingWound":
        entry.label = "Agonising Wound";
        entry.healDc = 22;
        entry.bedRest = "Until treated";
        entry.notes = "Treated as Painful Wound but -3 to all attack and skill rolls.";
        entry.penalties.allAttacks = -3;
        entry.penalties.allSkills = -3;
        break;
      case "sensoryOrganDamaged": {
        const organRoll = this.randomFromTable(4);
        const organMap = { 1: "Eye", 2: "Ear", 3: "Nose", 4: "Mouth" };
        entry.label = "Sensory Organ Damaged";
        entry.location = organMap[organRoll];
        entry.healDc = 22;
        entry.bedRest = "24 hours";
        if (organRoll === 1) {
          entry.notes = "Eye injured: -2 ranged attack, Search, and Spot.";
          entry.penalties.rangedAttack = -2;
          entry.penalties.search = -2;
          entry.penalties.spot = -2;
        } else if (organRoll === 2) {
          entry.notes = "Ear injured: -2 Balance and Listen.";
          entry.penalties.balance = -2;
          entry.penalties.listen = -2;
        } else if (organRoll === 3) {
          entry.notes = "Nose injured: -1 to all skill checks.";
          entry.penalties.allSkills = -1;
        } else {
          entry.notes = "Mouth injured: -2 to skill checks or abilities requiring speech.";
          entry.penalties.speech = -2;
        }
        break;
      }
      case "organDamage":
        entry.label = "Organ Damage";
        entry.healDc = 20;
        entry.bedRest = "1 week";
        entry.notes = "Until treated: -2 Fortitude saves; natural healing at half rate.";
        entry.penalties.fortitude = -2;
        break;
      case "excessiveBloodLoss":
        entry.label = "Excessive Blood Loss";
        entry.healDc = 15;
        entry.bedRest = "None";
        entry.notes = "Bleeding: lose 1 hp per combat round (1 hp/minute outside combat) until staunched. Tourniquet takes 2d4 rounds or cauterize with 5 damage worth of fire/intense heat.";
        break;
      case "limbMaimed": {
        const limbRoll = this.randomFromTable(6);
        const limbMap = { 1: "Left Hand", 2: "Right Hand", 3: "Left Arm", 4: "Right Arm", 5: "Left Leg", 6: "Right Leg" };
        entry.label = "Limb Maimed";
        entry.location = limbMap[limbRoll];
        entry.healDc = 25;
        entry.bedRest = "1 month";
        if (limbRoll <= 4) {
          entry.notes = `${entry.location}: -10 to skill, attack, or damage rolls using that limb; no shields on that arm.`;
          entry.penalties.allAttacks = -10;
        } else {
          entry.notes = `${entry.location}: 50% Speed penalty and -4 Dodge.`;
          entry.penalties.dodge = -4;
        }
        break;
      }
      case "sensoryOrganMaimed": {
        const organRoll = this.randomFromTable(4);
        const organMap = { 1: "Eyes", 2: "Ears", 3: "Nose", 4: "Mouth" };
        entry.label = "Sensory Organ Maimed";
        entry.location = organMap[organRoll];
        entry.healDc = 26;
        entry.bedRest = "1 month";
        if (organRoll === 1) entry.notes = "Eyes maimed: temporarily blinded.";
        else if (organRoll === 2) {
          entry.notes = "Ears maimed: -4 Balance and staggered.";
          entry.penalties.balance = -4;
        } else if (organRoll === 3) {
          entry.notes = "Nose maimed: -2 to all skill checks and 2d3 temporary Charisma damage.";
          entry.penalties.allSkills = -2;
        } else {
          entry.notes = "Mouth maimed: -5 to speech-related checks.";
          entry.penalties.speech = -5;
        }
        break;
      }
      case "organRupture":
        entry.label = "Organ Rupture";
        entry.healDc = 25;
        entry.bedRest = "1 month";
        entry.notes = "As Organ Damage, but -5 Fortitude saves and lose 1 temporary Constitution per day until bed rest begins.";
        entry.penalties.fortitude = -5;
        break;
      case "headTrauma":
        entry.label = "Head Trauma";
        entry.notes = "Immediate Massive Damage save; if survived, stunned for 1 round and staggered for 2d6 hours.";
        break;
    }

    return entry;
  }

  async rollPermanentDamageCheck({ damage, autoTrigger = false, maxWeaponDamage = false, physical = true, living = true } = {}) {
    // Apply the optional permanent damage rule and create an injury when triggered.
    if (!this.system.optionalRules.permanentDamage) return null;
    if (!physical || !living) return null;

    const threshold = clampNumber(this.system.combat.threshold.total);
    const trigger = Boolean(maxWeaponDamage || clampNumber(damage) > threshold || autoTrigger);
    if (!trigger) return null;

    const diff = clampNumber(damage) - threshold;
    const roll = await new Roll(`2d6 + ${diff}`).evaluate({ async: true });
    const total = roll.total;
    const result = this.constructor.getPermanentDamageResult(total);
    const injury = this.constructor.createPermanentDamageEntry(result.key, damage);

    if (result.key !== "noEffect") {
      const injuries = foundry.utils.deepClone(this.system.injuries ?? []);
      injuries.push(injury);
      await this.update({ "system.injuries": injuries });
    }

    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: this }),
      flavor: `Permanent Damage Check for ${this.name}: ${result.label}${injury.location ? ` (${injury.location})` : ""}`
    });

    return { roll, result, injury };
  }

  async removeInjury(injuryId) {
    // Permanently delete an injury row from the actor.
    const injuries = foundry.utils.deepClone(this.system.injuries ?? []).filter((i) => i.id !== injuryId);
    return this.update({ "system.injuries": injuries });
  }

  async toggleInjury(injuryId) {
    // Enable or disable an injury's penalties without deleting the record.
    const injuries = foundry.utils.deepClone(this.system.injuries ?? []);
    const injury = injuries.find((i) => i.id === injuryId);
    if (!injury) return null;
    injury.active = !injury.active;
    return this.update({ "system.injuries": injuries });
  }

  getClassRows() {
    // Return class rows with their per-level progression data attached.
    return getActorClassRows(this.system.classes, this.type);
  }

  getClassTotals() {
    // Return summed class-derived values across all class rows.
    return getActorClassTotals(this.system.classes, this.type);
  }

  async addClassRow(classKey) {
    // Add a new class row, defaulting to a sensible class by actor type.
    const current = Array.isArray(this.system.classes)
      ? foundry.utils.deepClone(this.system.classes)
      : [];
    current.push(createDefaultClassRow(classKey ?? (this.type === "npc" ? "soldier" : "barbarian")));
    return this.update({ "system.classes": current });
  }


}

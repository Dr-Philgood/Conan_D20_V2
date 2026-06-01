// Actor sheet: prepares class rows/totals for the Classes tab and wires sheet buttons.

import { CONAN } from "../config.mjs";
import { createDefaultClassRow, getActorClassRows, getActorClassTotals, getClassSelectOptions, getDefaultActorClassRows } from "../data/common.mjs";
import { getClassProgression } from "../data/classes.mjs";

function getClassFeatureRows(classRows) {
  return classRows.flatMap((classRow, classIndex) => {
    const level = Math.max(1, Number(classRow.level) || 1);
    const features = [];

    for (let currentLevel = 1; currentLevel <= level; currentLevel += 1) {
      const progression = getClassProgression(classRow.classKey, currentLevel);
      for (const feature of progression.features ?? []) {
        features.push({
          id: `${classIndex}-${currentLevel}-${feature}`,
          classLabel: progression.classLabel,
          level: currentLevel,
          name: feature
        });
      }
    }

    return features;
  });
}

export class ConanActorSheet extends ActorSheet {
  static get defaultOptions() {
    // Main sheet window layout and Foundry tab wiring.
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["conan", "sheet", "actor"],
      template: "systems/conan/templates/actor/character-sheet.hbs",
      width: 900,
      height: 780,
      tabs: [
        {
          navSelector: ".sheet-tabs",
          contentSelector: ".sheet-body",
          initial: "overview"
        }
      ]
    });
  }

  get template() {
    // Characters and NPCs use separate templates, but share this controller.
    return this.actor.type === "npc"
      ? "systems/conan/templates/actor/npc-sheet.hbs"
      : "systems/conan/templates/actor/character-sheet.hbs";
  }

  async getData(options = {}) {
    const context = await super.getData(options);

    // Split embedded items into inventory sections for the inventory tab.
    const items = {
      weapons: this.actor.items
        .filter((item) => item.type === "weapon")
        .map((item) => ({
          id: item.id,
          name: item.name,
          system: item.system,
          attackSequence: this.actor.getWeaponAttackSequence(item.id)
        })),
      armor: this.actor.items.filter((item) => item.type === "armor"),
      gear: this.actor.items.filter((item) => item.type === "gear")
    };

    // Always derive class rows/totals from actor data so multiclass UI stays in sync.
    const classRows = getActorClassRows(this.actor.system.classes ?? [], this.actor.type);
    const classTotals = getActorClassTotals(this.actor.system.classes ?? [], this.actor.type);

    return {
      ...context,
      config: CONAN,
      system: this.actor.system,
      items,
      injuries: this.actor.system.injuries ?? [],
      customSkills: this.actor.system.customSkills ?? { professions: [], crafts: [], performs: [] },
      sorcery: this.actor.system.sorcery ?? {},
      feats: this.actor.system.feats ?? [],
      social: this.actor.system.social ?? {},
      resources: this.actor.system.resources ?? {},
      movement: this.actor.system.movement ?? {},
      abilities: Object.entries(CONAN.abilities).map(([key, value]) => ({
        key,
        label: game.i18n.localize(value.label),
        short: value.short,
        data: this.actor.system.abilities[key]
      })),
      saves: Object.entries(CONAN.saves).map(([key, value]) => ({
        key,
        label: game.i18n.localize(value.label),
        data: this.actor.system.saves[key]
      })),
      skills: Object.entries(CONAN.skills).map(([key, value]) => ({
        key,
        label: value.label,
        data: this.actor.system.skills[key]
      })),
      classSelectOptions: getClassSelectOptions(),
      classRows,
      classTotals,
      classFeatureRows: getClassFeatureRows(classRows)
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    // Roll buttons on the overview and skills tabs.
    html.find(".rollable-ability").on("click", (event) => {
      event.preventDefault();
      const abilityKey = event.currentTarget.dataset.ability;
      this.actor.rollAbility(abilityKey);
    });

    html.find(".rollable-save").on("click", (event) => {
      event.preventDefault();
      const saveKey = event.currentTarget.dataset.save;
      this.actor.rollSave(saveKey);
    });

    html.find(".rollable-skill").on("click", (event) => {
      event.preventDefault();
      const skillKey = event.currentTarget.dataset.skill;
      this.actor.rollSkill(skillKey);
    });

    html.find(".rollable-custom-skill").on("click", (event) => {
      event.preventDefault();
      const group = event.currentTarget.dataset.group;
      const skillId = event.currentTarget.dataset.skillId;
      this.actor.rollCustomSkill(group, skillId);
    });

    html.find(".add-custom-skill").on("click", async (event) => {
      event.preventDefault();
      const group = event.currentTarget.dataset.group;
      await this.actor.addCustomSkill(group);
    });

    html.find(".delete-custom-skill").on("click", async (event) => {
      event.preventDefault();
      const group = event.currentTarget.dataset.group;
      const skillId = event.currentTarget.closest("[data-skill-id]")?.dataset.skillId;
      await this.actor.removeCustomSkill(group, skillId);
    });

    html.find(".add-sorcery-entry").on("click", async (event) => {
      event.preventDefault();
      const group = event.currentTarget.dataset.group;
      await this.actor.addSorceryEntry(group);
    });

    html.find(".delete-sorcery-entry").on("click", async (event) => {
      event.preventDefault();
      const group = event.currentTarget.dataset.group;
      const entryId = event.currentTarget.closest("[data-sorcery-id]")?.dataset.sorceryId;
      await this.actor.removeSorceryEntry(group, entryId);
    });

    html.find(".add-tracker-entry").on("click", async (event) => {
      event.preventDefault();
      const path = event.currentTarget.dataset.path;
      await this.actor.addTrackerEntry(path);
    });

    html.find(".delete-tracker-entry").on("click", async (event) => {
      event.preventDefault();
      const path = event.currentTarget.dataset.path;
      const entryId = event.currentTarget.closest("[data-tracker-id]")?.dataset.trackerId;
      await this.actor.removeTrackerEntry(path, entryId);
    });

    // Class row controls.
    html.find(".add-class-row").on("click", async (event) => {
      event.preventDefault();

      if (typeof this.actor.addClassRow === "function") {
        await this.actor.addClassRow();
        return;
      }

      const current = Array.isArray(this.actor.system.classes)
        ? foundry.utils.deepClone(this.actor.system.classes)
        : [];

      const fallbackClassKey = this.actor.type === "npc" ? "soldier" : "barbarian";
      current.push(createDefaultClassRow(fallbackClassKey));

      await this.actor.update({ "system.classes": current });
    });

    html.find(".remove-class-row").on("click", async (event) => {
      event.preventDefault();
      const index = Number(event.currentTarget.closest("[data-class-index]")?.dataset.classIndex);
      if (!Number.isInteger(index)) return;
      const current = Array.isArray(this.actor.system.classes)
        ? foundry.utils.deepClone(this.actor.system.classes)
        : [];
      current.splice(index, 1);
      if (current.length === 0) {
        current.push(...getDefaultActorClassRows(this.actor.type));
      }
      await this.actor.update({ "system.classes": current });
    });

    html.find(".rollable-initiative").on("click", (event) => {
      event.preventDefault();
      this.actor.rollInitiativeCheck();
    });

    html.find(".rollable-magic-attack").on("click", (event) => {
      event.preventDefault();
      this.actor.rollMagicAttack();
    });

    html.find(".spend-power-point").on("click", (event) => {
      event.preventDefault();
      this.actor.spendPowerPoint();
    });

    html.find(".recover-power-point").on("click", (event) => {
      event.preventDefault();
      this.actor.recoverPowerPoint();
    });

    html.find(".spend-fate-point").on("click", (event) => {
      event.preventDefault();
      this.actor.spendFatePoint();
    });

    html.find(".recover-fate-point").on("click", (event) => {
      event.preventDefault();
      this.actor.recoverFatePoint();
    });

    html.find(".rollable-corruption").on("click", (event) => {
      event.preventDefault();
      this.actor.rollCorruptionCheck();
    });

    // Embedded item buttons for attacks, damage, editing, creation, and deletion.
    html.find(".weapon-attack").on("click", (event) => {
      event.preventDefault();
      const itemId = event.currentTarget.closest("[data-item-id]")?.dataset.itemId;
      this.actor.rollWeaponAttack(itemId);
    });

    html.find(".weapon-full-attack").on("click", (event) => {
      event.preventDefault();
      const itemId = event.currentTarget.closest("[data-item-id]")?.dataset.itemId;
      this.actor.rollWeaponFullAttack(itemId);
    });

    html.find(".weapon-damage").on("click", (event) => {
      event.preventDefault();
      const itemId = event.currentTarget.closest("[data-item-id]")?.dataset.itemId;
      this.actor.rollWeaponDamage(itemId);
    });

    html.find(".item-create").on("click", async (event) => {
      event.preventDefault();
      const type = event.currentTarget.dataset.type;
      const name = `New ${type.charAt(0).toUpperCase()}${type.slice(1)}`;
      await this.actor.createEmbeddedDocuments("Item", [{ name, type }]);
    });

    html.find(".item-edit").on("click", (event) => {
      event.preventDefault();
      const itemId = event.currentTarget.closest("[data-item-id]")?.dataset.itemId;
      this.actor.items.get(itemId)?.sheet?.render(true);
    });

    html.find(".item-delete").on("click", async (event) => {
      event.preventDefault();
      const itemId = event.currentTarget.closest("[data-item-id]")?.dataset.itemId;
      if (!itemId) return;
      await this.actor.deleteEmbeddedDocuments("Item", [itemId]);
    });

    // Permanent damage controls and injury list actions.
    html.find(".permanent-damage-check").on("click", async (event) => {
      event.preventDefault();
      this._openPermanentDamageDialog();
    });

    html.find(".injury-toggle").on("click", async (event) => {
      event.preventDefault();
      const injuryId = event.currentTarget.closest("[data-injury-id]")?.dataset.injuryId;
      await this.actor.toggleInjury(injuryId);
    });

    html.find(".injury-delete").on("click", async (event) => {
      event.preventDefault();
      const injuryId = event.currentTarget.closest("[data-injury-id]")?.dataset.injuryId;
      await this.actor.removeInjury(injuryId);
    });
  }

  _openPermanentDamageDialog() {
    // Small dialog for entering the conditions that trigger permanent damage.
    const content = `
      <form class="conan-permanent-damage-form">
        <div class="form-group">
          <label>Damage Dealt</label>
          <input type="number" name="damage" value="0">
        </div>
        <div class="form-group">
          <label>Max Weapon Damage Rolled?</label>
          <input type="checkbox" name="maxWeaponDamage">
        </div>
        <div class="form-group">
          <label>Physical Attack?</label>
          <input type="checkbox" name="physical" checked>
        </div>
        <div class="form-group">
          <label>Living Target?</label>
          <input type="checkbox" name="living" checked>
        </div>
      </form>
    `;

    new Dialog({
      title: "Permanent Damage Check",
      content,
      buttons: {
        roll: {
          label: "Roll",
          callback: async (html) => {
            const form = html[0].querySelector(".conan-permanent-damage-form");
            const damage = Number(form.elements.damage.value || 0);
            const maxWeaponDamage = form.elements.maxWeaponDamage.checked;
            const physical = form.elements.physical.checked;
            const living = form.elements.living.checked;

            await this.actor.rollPermanentDamageCheck({
              damage,
              maxWeaponDamage,
              physical,
              living
            });
          }
        },
        cancel: {
          label: "Cancel"
        }
      },
      default: "roll"
    }).render(true);
  }
}

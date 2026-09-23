import 'package:flutter/material.dart';
import '../principals.dart';
import '../store.dart';
import '../theme.dart';
import 'avatar.dart';
import 'obligation_dialogs.dart';

class OwnerSelector extends StatelessWidget {
  final DashboardStore store;
  final TextEditingController ownerIdCtrl;
  final InputDecoration decoration;
  final ValueChanged<OwnerOption>? onSelected;
  final VoidCallback? onTextChanged;

  const OwnerSelector({
    super.key,
    required this.store,
    required this.ownerIdCtrl,
    required this.decoration,
    this.onSelected,
    this.onTextChanged,
  });

  @override
  Widget build(BuildContext context) {
    return Autocomplete<OwnerOption>(
      initialValue: TextEditingValue(text: ownerIdCtrl.text),
      displayStringForOption: (option) => option.display,
      onSelected: onSelected,
      optionsBuilder: (textEditingValue) {
        final text = textEditingValue.text.toLowerCase();
        final actors = store.actorStates.value.actors.values
            .where((a) => !a.isRetired)
            .map((a) => OwnerOption(kind: 'actor', id: a.id, handle: a.handle));
        // The durable user principal when the server resolved one, so a pick
        // from this list never writes the legacy alias back into a migrated
        // database; the alias only remains as the id on an instance that has
        // no durable user yet.
        final humans = [
          OwnerOption(
            kind: 'human',
            id: viewerOwnerId(store.dashboardConfig.value?.userPrincipalId),
            handle: store.operatorDisplayName ?? kOperatorDisplayHandle,
          ),
        ];
        final all = [...humans, ...actors];
        if (text.isEmpty) return all;
        return all.where((opt) => opt.handle.toLowerCase().contains(text) || opt.id.toLowerCase().contains(text));
      },
      fieldViewBuilder: (context, textEditingController, focusNode, onFieldSubmitted) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (ownerIdCtrl.text != textEditingController.text) {
            ownerIdCtrl.text = textEditingController.text;
          }
        });
        textEditingController.addListener(() {
          ownerIdCtrl.text = textEditingController.text;
        });
        
        return TextFormField(
          controller: textEditingController,
          focusNode: focusNode,
          style: const TextStyle(color: MeshColors.textPrimary, fontSize: 13, fontFamily: kMonoFontFamily),
          decoration: decoration.copyWith(
            suffixIcon: IconButton(
              icon: const Icon(Icons.arrow_drop_down, color: MeshColors.textSecondary),
              onPressed: () {
                textEditingController.clear();
                focusNode.requestFocus();
              },
            ),
          ),
          validator: (value) => (value == null || value.trim().isEmpty) ? 'Owner ID is required' : null,
          onFieldSubmitted: (_) => onFieldSubmitted(),
          onChanged: (_) => onTextChanged?.call(),
        );
      },
      optionsViewBuilder: (context, onSelected, options) {
        return Align(
          alignment: Alignment.topLeft,
          child: Material(
            elevation: 4,
            color: MeshColors.bgSecondary,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(4),
              side: const BorderSide(color: MeshColors.border),
            ),
            child: SizedBox(
              width: 380,
              height: 250,
              child: ListView.builder(
                padding: const EdgeInsets.symmetric(vertical: 4.0),
                itemCount: options.length,
                itemBuilder: (context, index) {
                  final option = options.elementAt(index);
                  return ListTile(
                    dense: true,
                    leading: option.kind == 'human'
                        ? const Icon(Icons.person, color: MeshColors.textSecondary, size: 24)
                        : ActorAvatar(id: option.id, size: 24, store: store),
                    title: Text(option.handle, style: const TextStyle(color: MeshColors.textPrimary)),
                    onTap: () => onSelected(option),
                  );
                },
              ),
            ),
          ),
        );
      },
    );
  }
}

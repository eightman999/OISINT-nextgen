import SwiftUI

struct LocationPickerView: View {
    @Bindable var store: HomeStore

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("01 / 場所", bundle: .module)
                        .oisintFont(10, .heavy)
                        .kerning(1.2)
                        .foregroundStyle(DesignTokens.Colors.orange.color)
                    Text("いまいる場所から探す", bundle: .module)
                        .oisintFont(15, .heavy)
                        .foregroundStyle(DesignTokens.Colors.text.color)
                    Text("位置情報は現在地付近を場所名に変換するためだけに使います。", bundle: .module)
                        .oisintFont(11)
                        .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                }
                Spacer()
                if store.selectedLocation != nil {
                    Button(String(localized: "クリア", bundle: .module)) {
                        store.clearLocation()
                    }
                    .buttonStyle(.plain)
                    .oisintFont(11, .bold)
                    .foregroundStyle(DesignTokens.Colors.textTertiary.color)
                    .accessibilityIdentifier("location-clear")
                }
            }

            if let location = store.selectedLocation {
                selectedLocation(location)
            } else {
                locationInputs
            }

            if !store.locationErrorMessage.isEmpty {
                Text(store.locationErrorMessage)
                    .oisintFont(11)
                    .foregroundStyle(DesignTokens.Colors.danger.color)
                    .accessibilityLabel(Text("位置情報エラー。\(store.locationErrorMessage)", bundle: .module))
                    .accessibilityIdentifier("location-error")
            } else {
                Text(store.locationState == .selected
                     ? String(localized: "場所名だけを調査条件に含め、OISINTの調査には座標を送信しません。", bundle: .module)
                     : String(localized: "許可しない場合も、場所名を入力して続けられます。", bundle: .module))
                    .oisintFont(10)
                    .foregroundStyle(DesignTokens.Colors.textTertiary.color)
            }
        }
        .padding(14)
        .background(DesignTokens.Colors.canvas.color)
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md))
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.md)
                .stroke(DesignTokens.Colors.borderSoft.color, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("location-picker")
    }

    private var locationInputs: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                Task { await store.requestCurrentLocation() }
            } label: {
                HStack(spacing: 7) {
                    if store.isLocationRequesting {
                        ProgressView()
                            .controlSize(.small)
                            .tint(DesignTokens.Colors.surface.color)
                    } else {
                        Image(systemName: "location.fill")
                    }
                    Text(store.isLocationRequesting ? String(localized: "現在地を取得中…", bundle: .module) : String(localized: "現在地を使う", bundle: .module))
                        .oisintFont(12, .heavy)
                }
                .foregroundStyle(DesignTokens.Colors.surface.color)
                .frame(minHeight: 38)
                .padding(.horizontal, 15)
                .background(
                    store.isLocationRequesting
                        ? DesignTokens.Colors.border.color
                        : DesignTokens.Colors.black.color
                )
                .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm))
            }
            .buttonStyle(.plain)
            .disabled(store.isLocationRequesting)
            .accessibilityHint(Text("許可後、現在地を市区町村付近の検索条件にします", bundle: .module))
            .accessibilityIdentifier("location-current")

            Text("または場所名を入力", bundle: .module)
                .oisintFont(10, .bold)
                .foregroundStyle(DesignTokens.Colors.textTertiary.color)

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    manualLocationField
                    applyManualLocationButton
                }
                VStack(alignment: .leading, spacing: 8) {
                    manualLocationField
                    applyManualLocationButton
                }
            }
        }
    }

    private var manualLocationField: some View {
        TextField(String(localized: "例：池袋駅、渋谷", bundle: .module), text: $store.manualLocation)
            .textFieldStyle(.plain)
            .oisintFont(13)
            .foregroundStyle(DesignTokens.Colors.text.color)
            .padding(.horizontal, 11)
            .frame(maxWidth: .infinity, minHeight: 38)
            .background(DesignTokens.Colors.surface.color)
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm))
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.sm)
                    .stroke(DesignTokens.Colors.border.color, lineWidth: 1)
            )
            .onSubmit { store.applyManualLocation() }
            .accessibilityLabel(Text("検索する場所", bundle: .module))
            .accessibilityHint(Text("駅名や市区町村を入力してください", bundle: .module))
            .accessibilityIdentifier("location-manual-input")
    }

    private var applyManualLocationButton: some View {
        Button(String(localized: "この場所を使う", bundle: .module)) {
            store.applyManualLocation()
        }
        .buttonStyle(.bordered)
        .disabled(store.manualLocation.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .accessibilityIdentifier("location-apply-manual")
    }

    private func selectedLocation(_ location: LocationSelection) -> some View {
        HStack(spacing: 10) {
            Image(systemName: location.source == .current ? "location.fill" : "mappin")
                .foregroundStyle(DesignTokens.Colors.success.color)
            VStack(alignment: .leading, spacing: 2) {
                Text(location.label)
                    .oisintFont(13, .bold)
                    .foregroundStyle(DesignTokens.Colors.text.color)
                    .accessibilityIdentifier("location-selected-label")
                Text(location.source == .current ? String(localized: "端末の現在地から取得", bundle: .module) : String(localized: "入力した場所", bundle: .module))
                    .oisintFont(11)
                    .foregroundStyle(DesignTokens.Colors.textSecondary.color)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(11)
        .background(DesignTokens.Colors.successSoft.color)
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("location-selected")
    }
}
